import os
import shutil
import sys
import glob
import argparse
from torch.utils.data import Dataset, DataLoader
import torch.nn.functional as F
import torch.nn as nn
import torch
torch.backends.cuda.matmul.allow_tf32 = False
torch.backends.cudnn.allow_tf32 = False
import matplotlib.pyplot as plt
import numpy as np
import pandas as pd

SRC = "/kaggle/input/datasets/chhido/ginot-test-data-and-configs"
DST = "/kaggle/working/ginot_test_data_and_configs"

if not os.path.exists(DST):
    shutil.copytree(SRC, DST)

sys.path.append("/kaggle/working")

from ginot_test_data_and_configs import configs

from ginot_test_data_and_configs.point_encoding import (
    PointCloudPerceiverChannelsEncoder
)

from ginot_test_data_and_configs.UNets import UNet

from ginot_test_data_and_configs import torch_trainer

from ginot_test_data_and_configs.transformer import (
    SelfAttentionBlocks,
    MLP,
    ResidualCrossAttentionBlock
)

from ginot_test_data_and_configs.point_position_embedding import (
    PosEmbLinear,
    encode_position,
    position_encoding_channels
)

device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
print("Using device:", device)

class MildFourierEncoder(nn.Module):
    def __init__(self, in_channels=3, base_length=1.0, min_length=0.1, num_bands=4):
        super().__init__()
        # Calculate angular frequencies (w = 2 * pi / L)
        w_min = 2 * np.pi / base_length
        w_max = 2 * np.pi / min_length
        
        # Linearly space the frequency bands to prevent high-frequency derivative chaos
        freqs = torch.linspace(w_min, w_max, steps=num_bands)
        
        # Register as a buffer so it moves to the GPU but isn't updated by the optimizer
        self.register_buffer('freqs', freqs)
        
        # 24 channels total (3 dimensions * 4 bands * 2 for sin/cos)
        self.out_channels = in_channels * num_bands * 2 

    def forward(self, x):
        # x shape: (Batch, N, 3)
        # Expand for broadcasting: x -> (B, N, 3, 1), freqs -> (1, 1, 1, 4)
        x_expanded = x.unsqueeze(-1)
        freqs_expanded = self.freqs.view(1, 1, 1, -1)
        
        # Scale coordinates by frequencies: (B, N, 3, 4)
        scaled_x = x_expanded * freqs_expanded
        
        # Apply sine and cosine
        sin_x = torch.sin(scaled_x)
        cos_x = torch.cos(scaled_x)
        
        # Flatten the spatial-channel and frequency dimensions -> (Batch, N, 24)
        out = torch.cat([sin_x, cos_x], dim=-1).view(x.shape[0], x.shape[1], -1)
        return out

class Trunk(nn.Module):
    def __init__(self, branch, embed_dim=256, cross_attn_layers=5, num_heads=8,
                 in_channels=3, out_channels=4, min_length_norm=0.1): 
        super().__init__()
        self.branch = branch
        
        # --- 1. The Physics-Bounded Spatial Encoder ---
        self.fourier_enc = MildFourierEncoder(
            in_channels=in_channels, 
            base_length=1.0, 
            min_length=min_length_norm, 
            num_bands=4
        )
        
        # --- 2. Spatial Query Encoder (Accepts the 24-channel Fourier output) ---
        self.Q_encoder = nn.Sequential(
            nn.Linear(self.fourier_enc.out_channels, 2 * embed_dim), nn.SiLU(),
            nn.Linear(2 * embed_dim, embed_dim)
        )

        # --- 3. Point Cloud Latent Smoother ---
        self.latent_encoder = nn.Sequential(
            nn.Linear(embed_dim, 2 * embed_dim), nn.SiLU(),
            nn.Linear(2 * embed_dim, embed_dim), nn.SiLU()
        )

        # --- 4. Cross-Attention Geometry Fusion ---
        self.resblocks = nn.ModuleList([
            ResidualCrossAttentionBlock(width=embed_dim, heads=num_heads, dropout=0.0)
            for _ in range(cross_attn_layers)
        ])
        
        # --- 5. Physics Output Projector ---
        self.output_proj = nn.Sequential(
            nn.Linear(embed_dim, 2 * embed_dim), nn.SiLU(),
            nn.Linear(2 * embed_dim, out_channels)
        )

    def encode_geometry(self, pc, sample_ids=None):
        # NOTE: Be absolutely sure your branch (e.g., PointNet) is initialized 
        # to accept in_channels=11 (x,y,z + 4 masks + u,v,w,p)
        latent = self.branch(pc, sample_ids=sample_ids)
        return self.latent_encoder(latent)

    def decode_query(self, latent, xyt):
        # Transform the pure XYZ coordinates into the sharp Fourier feature space
        xyt_encoded = self.fourier_enc(xyt)
        
        # Pass to the MLP
        x = self.Q_encoder(xyt_encoded)
        
        # Cross-Attention with the physics-aware Point Cloud
        for block in self.resblocks:
            x = block(x, latent)  
            
        x = self.output_proj(x)
        return x.squeeze(-1)

    def forward(self, xyt, pc, sample_ids=None):
        latent = self.encode_geometry(pc, sample_ids)
        return self.decode_query(latent, xyt)


def NOTModelDefinition(branch_args, trunk_args):
    # 1. Build the Geometry Encoder (Branch)
    branch = PointCloudPerceiverChannelsEncoder(**branch_args)
    branch_tot = sum(p.numel() for p in branch.parameters())
    branch_train = sum(p.numel() for p in branch.parameters() if p.requires_grad)
    print(f"[Branch] Geo Encoder: {branch_tot:,} total params, {branch_train:,} trainable")

    # 2. Build the Physics Decoder (Trunk) - automatically includes the Branch
    trunk = Trunk(branch, **trunk_args)
    model_tot = sum(p.numel() for p in trunk.parameters())
    model_train = sum(p.numel() for p in trunk.parameters() if p.requires_grad)
    print(f"[Total] Assembled PI-GINOT: {model_tot:,} total params, {model_train:,} trainable")

    # Returns the fully assembled end-to-end model
    return trunk


class Eager_GINOT_CFD_Dataset(Dataset):
    def __init__(self, data_dir, 
                 # --- RAM POOLS ---
                 n_case_pool=300000,      
                 n_boundary_pool=100000,  
                 n_pc=15000,              
                 
                 # --- GPU BATCHES ---
                 n_collocation_batch=8192, 
                 n_supervised_batch=100,   
                 n_boundary_batch=4096,    
                 n_inlet_batch=800,        
                 n_outlet_batch=800,
                 n_leak_batch=800):        # <-- ADDED: Leak batch size
        super().__init__()
        
        self.data_dir = data_dir
        
        self.n_colloc = n_collocation_batch
        self.n_super = n_supervised_batch
        self.n_wall_batch = n_boundary_batch
        self.n_in_batch = n_inlet_batch
        self.n_out_batch = n_outlet_batch
        self.n_leak_batch = n_leak_batch   # <-- ADDED

        self.cols_xyz = ['X (m)', 'Y (m)', 'Z (m)']
        self.cols_uvwp = ['Velocity[i] (m/s)', 'Velocity[j] (m/s)', 'Velocity[k] (m/s)', 'Pressure (Pa)']

        print("\n--- INITIALIZING EAGER DATASET ---")
        self._load_and_process_data(n_case_pool, n_boundary_pool, n_pc)

        if torch.isnan(self.pool_stream_xyz).any() or torch.isnan(self.pool_bg_xyz).any():
            print("❌ FATAL ERROR: RAM Pools contain NaNs AFTER normalization!")
        else:
            print("✅ DATASET HEALTH CHECK PASSED: 0 NaNs detected in RAM.")

        print("--- EAGER DATASET READY ---\n")

    def _load_and_process_data(self, n_case, n_wall, n_pc):
        all_files = glob.glob(os.path.join(self.data_dir, "**", "*.csv"), recursive=True)
        
        dfs_case, dfs_wall, dfs_in, dfs_out, dfs_leak = [], [], [], [], [] # <-- ADDED: dfs_leak

        for f in all_files:
            filename = os.path.basename(f).lower()
            df = pd.read_csv(f).replace([np.inf, -np.inf], np.nan).dropna()
            
            for col in self.cols_uvwp:
                if col not in df.columns:
                    df[col] = 0.0
            
            if "case" in filename:
                dfs_case.append(df)
            elif "leak" in filename: # <-- ADDED: Leak routing
                dfs_leak.append(df)
            elif "outlet" in filename or "inlet" in filename:
                for col in ['Velocity[i] (m/s)', 'Velocity[j] (m/s)', 'Velocity[k] (m/s)']:
                    df[col] = df[col].apply(lambda x: 0.0 if abs(x) < 1e-4 else x)

                vel_mag = np.sqrt(df['Velocity[i] (m/s)']**2 + 
                                  df['Velocity[j] (m/s)']**2 + 
                                  df['Velocity[k] (m/s)']**2)
                
                active_mask = vel_mag > 0.01
                dead_mask = vel_mag <= 0.01
                
                df_active = df[active_mask]
                df_dead = df[dead_mask]
                
                if "outlet" in filename and not df_active.empty:
                    dfs_out.append(df_active)
                elif "inlet" in filename and not df_active.empty:
                    dfs_in.append(df_active)
                
                if not df_dead.empty:
                    df_dead_copy = df_dead.copy()
                    for col in self.cols_uvwp:
                        df_dead_copy[col] = 0.0
                    dfs_wall.append(df_dead_copy)
                    
            else:
                for col in self.cols_uvwp:
                    df[col] = 0.0
                dfs_wall.append(df)
            
        df_case = pd.concat(dfs_case, ignore_index=True).fillna(0.0)
        df_wall = pd.concat(dfs_wall, ignore_index=True).fillna(0.0)
        
        dummy_cols = self.cols_xyz + self.cols_uvwp
        df_in = pd.concat(dfs_in, ignore_index=True).fillna(0.0) if dfs_in else pd.DataFrame(columns=dummy_cols)
        df_out = pd.concat(dfs_out, ignore_index=True).fillna(0.0) if dfs_out else pd.DataFrame(columns=dummy_cols)
        df_leak = pd.concat(dfs_leak, ignore_index=True).fillna(0.0) if dfs_leak else pd.DataFrame(columns=dummy_cols) # <-- ADDED

        print(f"Raw Files: {len(df_case)} Case, {len(df_wall)} Wall, {len(df_in)} In, {len(df_out)} Out, {len(df_leak)} Leak.")
    
        all_case_xyz, all_case_tgt = self._extract_tensors(df_case)
        all_wall_xyz, all_wall_tgt = self._extract_tensors(df_wall)
        all_in_xyz, all_in_tgt = self._extract_tensors(df_in)
        all_out_xyz, all_out_tgt = self._extract_tensors(df_out)
        all_leak_xyz, all_leak_tgt = self._extract_tensors(df_leak) # <-- ADDED
    
        global_xyz = torch.cat([all_case_xyz, all_wall_xyz, all_in_xyz, all_out_xyz, all_leak_xyz], dim=0) # <-- ADDED
        global_tgt = torch.cat([all_case_tgt, all_wall_tgt, all_in_tgt, all_out_tgt, all_leak_tgt], dim=0) # <-- ADDED
    
        self.coord_min = global_xyz.min(dim=0)[0]
        self.coord_max = global_xyz.max(dim=0)[0]
        self.coord_scale = self.coord_max - self.coord_min
        self.coord_scale = torch.where(self.coord_scale < 1e-6, torch.ones_like(self.coord_scale), self.coord_scale)
    
        self.target_mean = global_tgt.mean(dim=0)
        self.target_std = global_tgt.std(dim=0)
        self.target_std = torch.where(self.target_std < 1e-6, torch.ones_like(self.target_std), self.target_std)
    
        del global_xyz, global_tgt 
    
        # (Geometric Subsampling Code remains identical)
        vent_xy = torch.cat([all_in_xyz[:, :2], all_out_xyz[:, :2]], dim=0) # Included leak in vent radius
        case_xy = all_case_xyz[:, :2]
        
        chunk_size = 100000  
        is_under_vent = torch.zeros(len(case_xy), dtype=torch.bool)
        vent_radius = 0.6  
        
        if len(vent_xy) > 0:
            for i in range(0, len(case_xy), chunk_size):
                chunk_xy = case_xy[i : i+chunk_size]
                dists = torch.cdist(chunk_xy, vent_xy)
                is_under_vent[i : i+chunk_size] = dists.min(dim=1)[0] <= vent_radius

        raw_stream_xyz = all_case_xyz[is_under_vent]
        raw_stream_tgt = all_case_tgt[is_under_vent]
        raw_bg_xyz = all_case_xyz[~is_under_vent]
        raw_bg_tgt = all_case_tgt[~is_under_vent]

        n_stream_keep = min(len(raw_stream_xyz), int(n_case * 0.4)) 
        n_bg_keep = min(len(raw_bg_xyz), n_case - n_stream_keep)
        
        idx_stream = torch.randperm(len(raw_stream_xyz))[:n_stream_keep]
        idx_bg = torch.randperm(len(raw_bg_xyz))[:n_bg_keep]

        self.pool_stream_xyz = (raw_stream_xyz[idx_stream] - self.coord_min) / self.coord_scale
        self.pool_stream_tgt = (raw_stream_tgt[idx_stream] - self.target_mean) / self.target_std
        
        self.pool_bg_xyz = (raw_bg_xyz[idx_bg] - self.coord_min) / self.coord_scale
        self.pool_bg_tgt = (raw_bg_tgt[idx_bg] - self.target_mean) / self.target_std

        # ==========================================
        # BOUNDARY & PC PREPARATION
        # ==========================================
        wall_idx = torch.randperm(len(all_wall_xyz))[:n_wall]
        in_idx = torch.arange(len(all_in_xyz))
        out_idx = torch.arange(len(all_out_xyz))
        leak_idx = torch.arange(len(all_leak_xyz)) # <-- ADDED
    
        self.pool_wall_xyz = (all_wall_xyz[wall_idx] - self.coord_min) / self.coord_scale
        self.pool_wall_tgt = (all_wall_tgt[wall_idx] - self.target_mean) / self.target_std
    
        self.pool_in_xyz = (all_in_xyz[in_idx] - self.coord_min) / self.coord_scale
        self.pool_in_tgt = (all_in_tgt[in_idx] - self.target_mean) / self.target_std
    
        self.pool_out_xyz = (all_out_xyz[out_idx] - self.coord_min) / self.coord_scale
        self.pool_out_tgt = (all_out_tgt[out_idx] - self.target_mean) / self.target_std

        self.pool_leak_xyz = (all_leak_xyz[leak_idx] - self.coord_min) / self.coord_scale # <-- ADDED
        self.pool_leak_tgt = (all_leak_tgt[leak_idx] - self.target_mean) / self.target_std # <-- ADDED

        all_wall_norm_tgt = (all_wall_tgt - self.target_mean) / self.target_std
        all_in_norm_tgt = (all_in_tgt - self.target_mean) / self.target_std
        all_out_norm_tgt = (all_out_tgt - self.target_mean) / self.target_std
        all_leak_norm_tgt = (all_leak_tgt - self.target_mean) / self.target_std # <-- ADDED

        # Blinding Logic
        pc_wall_tgt = all_wall_norm_tgt.clone()
        pc_wall_tgt[:, 3] = 0.0  
        pc_in_tgt = all_in_norm_tgt.clone()
        pc_in_tgt[:, 3] = 0.0    
        pc_out_tgt = all_out_norm_tgt.clone()
        pc_out_tgt[:, 0:2] = 0.0 
        
        # FIX: PASSIVE LEAK BLINDING
        # We know Pressure (Gauge 0). We DO NOT know Velocity (let PDE figure it out).
        pc_leak_tgt = all_leak_norm_tgt.clone()
        pc_leak_tgt[:, 0:3] = 0.0 # Zero out U, V, and W

        # FIX: NUM_CLASSES = 5 (Added Mask 4 for Leak)
        wall_mask_oh = torch.nn.functional.one_hot(torch.full((len(all_wall_xyz),), 1), num_classes=5).float()
        in_mask_oh   = torch.nn.functional.one_hot(torch.full((len(all_in_xyz),), 2), num_classes=5).float()
        out_mask_oh  = torch.nn.functional.one_hot(torch.full((len(all_out_xyz),), 3), num_classes=5).float()
        leak_mask_oh = torch.nn.functional.one_hot(torch.full((len(all_leak_xyz),), 4), num_classes=5).float() # <-- ADDED

        wall_feat = torch.cat([wall_mask_oh, pc_wall_tgt], dim=1)
        in_feat   = torch.cat([in_mask_oh, pc_in_tgt], dim=1)
        out_feat  = torch.cat([out_mask_oh, pc_out_tgt], dim=1)
        leak_feat = torch.cat([leak_mask_oh, pc_leak_tgt], dim=1) # <-- ADDED

        all_boundary_xyz = torch.cat([all_wall_xyz, all_in_xyz, all_out_xyz, all_leak_xyz], dim=0) # <-- ADDED
        all_boundary_feat = torch.cat([wall_feat, in_feat, out_feat, leak_feat], dim=0) # <-- ADDED
        
        n_in_keep = len(all_in_xyz)
        n_out_keep = len(all_out_xyz)
        
        # 2. Calculate the remaining RAM budget for the Point Cloud
        remaining_pc_budget = max(0, n_pc - (n_in_keep + n_out_keep))
        
        # 3. Split the remaining budget between the massive Wall and Leak arrays
        n_leak_keep = min(len(all_leak_xyz), int(remaining_pc_budget * 0.5))
        n_wall_keep = min(len(all_wall_xyz), remaining_pc_budget - n_leak_keep)
        
        # 4. Sample the indices to meet the exact budget
        leak_pc_idx = torch.randperm(len(all_leak_xyz))[:n_leak_keep]
        wall_pc_idx = torch.randperm(len(all_wall_xyz))[:n_wall_keep]
        
        # 5. Concatenate the carefully budgeted arrays
        pc_xyz = torch.cat([all_wall_xyz[wall_pc_idx], all_in_xyz, all_out_xyz, all_leak_xyz[leak_pc_idx]], dim=0)
        pc_feat = torch.cat([wall_feat[wall_pc_idx], in_feat, out_feat, leak_feat[leak_pc_idx]], dim=0)
        
        # 6. Shuffle! If we don't shuffle, Farthest Point Sampling will heavily bias one end of the array.
        shuffle_idx = torch.randperm(len(pc_xyz))
        pc_xyz = pc_xyz[shuffle_idx]
        pc_feat = pc_feat[shuffle_idx]
        
        self.pc_norm_xyz = (pc_xyz - self.coord_min) / self.coord_scale
        
        self.pc_full = torch.cat([self.pc_norm_xyz, pc_feat], dim=1)

    def _extract_tensors(self, df):
        xyz = torch.tensor(df[self.cols_xyz].values, dtype=torch.float32)
        targets = torch.tensor(df[self.cols_uvwp].values, dtype=torch.float32)
        return xyz, targets

    def __len__(self):
        return 1 

    def __getitem__(self, idx):
        n_case_needed = self.n_colloc + self.n_super
        n_stream = int(n_case_needed * 0.60)
        n_bg = n_case_needed - n_stream
        
        idx_stream = torch.randint(high=len(self.pool_stream_xyz), size=(n_stream,))
        idx_bg = torch.randint(high=len(self.pool_bg_xyz), size=(n_bg,))
        
        batch_case_xyz = torch.cat([self.pool_stream_xyz[idx_stream], self.pool_bg_xyz[idx_bg]], dim=0)
        batch_case_tgt = torch.cat([self.pool_stream_tgt[idx_stream], self.pool_bg_tgt[idx_bg]], dim=0)
        
        shuffle_idx = torch.randperm(len(batch_case_xyz))
        batch_case_xyz = batch_case_xyz[shuffle_idx]
        batch_case_tgt = batch_case_tgt[shuffle_idx]

        batch_case_mask = torch.full((len(batch_case_xyz),), 0, dtype=torch.long)

        wall_idx = torch.randperm(len(self.pool_wall_xyz))[:self.n_wall_batch]
        batch_wall_xyz = self.pool_wall_xyz[wall_idx]
        batch_wall_tgt = self.pool_wall_tgt[wall_idx]
        batch_wall_mask = torch.full((len(batch_wall_xyz),), 1, dtype=torch.long)

        in_idx = torch.randperm(len(self.pool_in_xyz))[:self.n_in_batch]
        batch_in_xyz = self.pool_in_xyz[in_idx]
        batch_in_tgt = self.pool_in_tgt[in_idx]
        batch_in_mask = torch.full((len(batch_in_xyz),), 2, dtype=torch.long)

        out_idx = torch.randperm(len(self.pool_out_xyz))[:self.n_out_batch]
        batch_out_xyz = self.pool_out_xyz[out_idx]
        batch_out_tgt = self.pool_out_tgt[out_idx]
        batch_out_mask = torch.full((len(batch_out_xyz),), 3, dtype=torch.long)

        # FIX: SAMPLE LEAK POINTS
        leak_idx = torch.randperm(len(self.pool_leak_xyz))[:self.n_leak_batch]
        batch_leak_xyz = self.pool_leak_xyz[leak_idx]
        batch_leak_tgt = self.pool_leak_tgt[leak_idx]
        batch_leak_mask = torch.full((len(batch_leak_xyz),), 4, dtype=torch.long)

        batch_xyt = torch.cat([batch_case_xyz, batch_wall_xyz, batch_in_xyz, batch_out_xyz, batch_leak_xyz], dim=0)
        batch_targets = torch.cat([batch_case_tgt, batch_wall_tgt, batch_in_tgt, batch_out_tgt, batch_leak_tgt], dim=0)
        batch_masks = torch.cat([batch_case_mask, batch_wall_mask, batch_in_mask, batch_out_mask, batch_leak_mask], dim=0)

        total_case_points = len(self.pool_stream_xyz) + len(self.pool_bg_xyz)

        return {
            "pc": self.pc_full.unsqueeze(0),                
            "xyt": batch_xyt.unsqueeze(0),          
            "targets": batch_targets.unsqueeze(0),  
            "bc_mask": batch_masks.unsqueeze(0),
            
            "n_colloc": min(self.n_colloc, total_case_points),
            "n_super": min(self.n_super, max(0, total_case_points - self.n_colloc)),
            "n_boundary_total": len(batch_wall_xyz) + len(batch_in_xyz) + len(batch_out_xyz) + len(batch_leak_xyz),
            
            "coord_scale": self.coord_scale,
            "target_mean": self.target_mean,
            "target_std": self.target_std
        }


DATA_DIR = "/kaggle/input/datasets/neodecade/final-ginot-dataset-1-case" 

print("Initializing Dataset to compute global normalization constants...")
# Set the pools to 5 Million to guarantee we capture all 3 million raw points
dataset = Eager_GINOT_CFD_Dataset(
    data_dir=DATA_DIR,
    n_case_pool=5000000,    # <--- Forces all interior points to load
    n_boundary_pool=1000000, # <--- Forces all wall points to load
    n_pc=60000
    )


# Extract the calculated scales directly from the dataset instance
# Move them to the correct device (GPU/CPU) for inference
COORD_MIN = dataset.coord_min.to(device)
COORD_SCALE = dataset.coord_scale.to(device)

TARGET_MEAN = dataset.target_mean.to(device)
TARGET_STD = dataset.target_std.to(device)

print("\n--- Extracted Normalization Constants ---")
print(f"Coordinate Min: {COORD_MIN.tolist()}")
print(f"Coordinate Scale: {COORD_SCALE.tolist()}")
print(f"Target Mean (UVWP): {TARGET_MEAN.tolist()}")
print(f"Target Std (UVWP): {TARGET_STD.tolist()}")


max_room_size_meters = dataset.coord_scale.max().item()
vent_width_meters = 0.7  # Adjust this to the actual width of your AC vents

# Calculate the normalized Nyquist limit for the Fourier Encoder
min_length_norm = vent_width_meters / max_room_size_meters
print(f"Fourier Encoder Min Length (Normalized): {min_length_norm:.4f}")

# =========================================================
# 1. BRANCH CONFIGURATION (The Geometry Encoder)
# =========================================================
branch_args = {
    "input_channels": 12,     
    
    # CRITICAL FIX 2: Must perfectly match trunk's embed_dim
    "out_c": 256,             
    
    "width": 128,            # Can stay 128, or bump to 256 if you want a wider PointNet MLP
    "latent_d": 1024,         # The number of shape tokens
    "n_point": 1024,          # Number of points sampled via PointNet++ FPS
    "radius": 0.08           # Spatial radius for local point aggregation
}

# =========================================================
# 2. TRUNK CONFIGURATION (The Spatial Physics Solver)
# =========================================================
trunk_args = {
    "in_channels": 3,          # Input: (X, Y, Z) spatial queries
    "out_channels": 4,         # Output: Predicts (u, v, w, p)
    "embed_dim": 256,          # Internal capacity for 3D fluid dynamics
    "cross_attn_layers": 5,    # Deep enough to fuse geometry, shallow enough for PDE autograd
    
    # CRITICAL FIX 3 & 4: Replaced emd_version with the stable physics-bounded Fourier scale
    "min_length_norm": min_length_norm  # Make sure you calculated this from the dataset!
}

# 2. Build the Model
print("Building Architecture...")
model = NOTModelDefinition(branch_args, trunk_args).to(device)

# 3. Load the Trained Weights
weights_path = "/kaggle/input/datasets/chhido/ginot-case1/ginot_trained_fourier.pth" # UPDATE THIS PATH
model.load_state_dict(torch.load(weights_path, map_location=device))
model.eval()
print("Weights loaded successfully!")


# Simulating the payload received via API (e.g., from the web app)
# Format: [X, Y, Z, Physical_U, Physical_V, Physical_W, Physical_P]
frontend_payload = {
    "walls": np.random.rand(2000, 3) * 5.0, # X,Y,Z (u,v,w are 0 by definition)
    "inlet": {
        "coords": np.array([[1.0, 2.0, 3.0], [1.1, 2.0, 3.0]]),
        "velocity": [0.0, -2.5, 0.0] # e.g., AC blowing downwards at 2.5 m/s. 
                                     # IMPORTANT: Verify vector directions aren't inverted in the UI!
    },
    "outlet": {
        "coords": np.array([[4.0, 1.0, 0.5], [4.1, 1.0, 0.5]]),
        "pressure": 0.0 # Gauge pressure
    },
    "leak": {
        "coords": np.array([[0.0, 0.0, 0.1]]),
        "pressure": 0.0
    }
}

def build_point_cloud(payload):
    points = []
    
    # 1. Process Walls (Mask 1)
    for xyz in payload["walls"]:
        # xyz, mask 1 is 1.0, uvwp = 0 (no slip)
        points.append([xyz[0], xyz[1], xyz[2], 0, 1, 0, 0, 0, 0.0, 0.0, 0.0, 0.0])
        
    # 2. Process Inlet (Mask 2)
    u, v, w = payload["inlet"]["velocity"]
    for xyz in payload["inlet"]["coords"]:
        points.append([xyz[0], xyz[1], xyz[2], 0, 0, 1, 0, 0, u, v, w, 0.0])
        
    # 3. Process Outlet (Mask 3)
    p_out = payload["outlet"]["pressure"]
    for xyz in payload["outlet"]["coords"]:
        points.append([xyz[0], xyz[1], xyz[2], 0, 0, 0, 1, 0, 0.0, 0.0, 0.0, p_out])
        
    # 4. Process Leak (Mask 4)
    p_leak = payload["leak"]["pressure"]
    for xyz in payload["leak"]["coords"]:
        points.append([xyz[0], xyz[1], xyz[2], 0, 0, 0, 0, 1, 0.0, 0.0, 0.0, p_leak])
        
    pc_tensor = torch.tensor(points, dtype=torch.float32, device=device)
    
    # Normalize Coordinates
    pc_tensor[:, 0:3] = (pc_tensor[:, 0:3] - COORD_MIN) / COORD_SCALE
    
    # Normalize Targets (UVWP)
    # Note: For blinded values (like pressure at the inlet), we leave them as 0.0 after normalization
    pc_tensor[:, 8:12] = (pc_tensor[:, 8:12] - TARGET_MEAN) / TARGET_STD
    
    return pc_tensor.unsqueeze(0) # Shape: (1, N, 12)

pc_input = build_point_cloud(frontend_payload)
print(f"Point Cloud Input Shape: {pc_input.shape}")


def generate_query_slice(z_height=1.5, resolution=50):
    # Example: A 2D slice at typical head height (1.5 meters)
    x = np.linspace(0, COORD_SCALE[0].item(), resolution)
    y = np.linspace(0, COORD_SCALE[1].item(), resolution)
    
    xx, yy = np.meshgrid(x, y)
    zz = np.full_like(xx, z_height)
    
    # Flatten into a list of coordinates
    grid_coords = np.stack([xx.flatten(), yy.flatten(), zz.flatten()], axis=1)
    
    query_tensor = torch.tensor(grid_coords, dtype=torch.float32, device=device)
    
    # Normalize Queries!
    query_tensor = (query_tensor - COORD_MIN) / COORD_SCALE
    
    return query_tensor.unsqueeze(0), grid_coords # Shape: (1, N, 3)

xyt_input, raw_coords = generate_query_slice()
print(f"Query Input Shape: {xyt_input.shape}")

# DUMMY MODEL BEHAVIOR (For testing the pipeline before loading the real weights)
# In production: 
model.eval()
with torch.no_grad():
    raw_predictions = model(xyt_input, pc_input)

# # Simulating model output of shape (1, N, 4)
# raw_predictions = torch.randn((1, xyt_input.shape[1], 4), device=device)

# --- POSTPROCESSING ---
raw_predictions = raw_predictions.squeeze(0)

# Un-scale to physical units
physical_predictions = (raw_predictions * TARGET_STD) + TARGET_MEAN

# Package for the frontend API response
response_data = []
for i in range(len(raw_coords)):
    response_data.append({
        "x": float(raw_coords[i][0]),
        "y": float(raw_coords[i][1]),
        "z": float(raw_coords[i][2]),
        "u": float(physical_predictions[i][0]),
        "v": float(physical_predictions[i][1]),
        "w": float(physical_predictions[i][2]),
        "p": float(physical_predictions[i][3])
    })

print(f"Successfully processed {len(response_data)} coordinate predictions for the UI.")


# 1. Extract data from the response payload
x_vals = np.array([d["x"] for d in response_data])
y_vals = np.array([d["y"] for d in response_data])
u_vals = np.array([d["u"] for d in response_data])
v_vals = np.array([d["v"] for d in response_data])
p_vals = np.array([d["p"] for d in response_data])

# Calculate wind speed (velocity magnitude) for coloring the arrows
speed = np.sqrt(u_vals**2 + v_vals**2)

# 2. Setup the figure
fig, (ax1, ax2) = plt.subplots(1, 2, figsize=(16, 6))

# --- Plot 1: Airflow Velocity (Vector Field) ---
# Using a quiver plot to show flow direction and speed
quiver = ax1.quiver(
    x_vals, y_vals, u_vals, v_vals, speed, 
    cmap='coolwarm', scale=20, pivot='mid'
)
ax1.set_title("Predicted Airflow Velocity Field (Z = 1.5m)")
ax1.set_xlabel("X coordinate (m)")
ax1.set_ylabel("Y coordinate (m)")
ax1.set_aspect('equal')
fig.colorbar(quiver, ax=ax1, label='Wind Speed (m/s)')

# --- Plot 2: Pressure Field (Heatmap) ---
# Using a scatter plot to map the pressure distribution
scatter = ax2.scatter(
    x_vals, y_vals, c=p_vals, 
    cmap='viridis', s=40, marker='s'
)
ax2.set_title("Predicted Pressure Field (Z = 1.5m)")
ax2.set_xlabel("X coordinate (m)")
ax2.set_ylabel("Y coordinate (m)")
ax2.set_aspect('equal')
fig.colorbar(scatter, ax=ax2, label='Pressure (Pa)')

plt.tight_layout()
plt.show()

def predict_full_room_chunked(model, dataset, device, chunk_size=50000):
    # 1. Reassemble the full interior space from the stratified pools
    full_xyz_norm = torch.cat([dataset.pool_stream_xyz, dataset.pool_bg_xyz], dim=0)
    full_tgt_norm = torch.cat([dataset.pool_stream_tgt, dataset.pool_bg_tgt], dim=0)
    
    xyt_norm_full = full_xyz_norm.unsqueeze(0) 
    true_targets_norm_full = full_tgt_norm      
    
    print(f"Preparing full room prediction for {xyt_norm_full.shape[1]:,} points...")
    model.eval() 
    
    with torch.no_grad(): 
        # 2. Encode Geometry ONCE using the 12-channel Point Cloud
        pc = dataset.pc_full.unsqueeze(0).to(device)
        print("Encoding Physics-Aware Point Cloud...")
        latent = model.encode_geometry(pc)
        
        total_points = xyt_norm_full.shape[1]
        preds_norm_list = []
        
        print(f"Solving Navier-Stokes Field in chunks of {chunk_size:,}...")
        
        # 3. The Chunking Loop
        for i in range(0, total_points, chunk_size):
            end_idx = min(i + chunk_size, total_points)
            
            # Slice the chunk and move ONLY the chunk to the GPU
            xyt_chunk = xyt_norm_full[:, i:end_idx, :].to(device)
            
            # Predict the chunk
            pred_chunk = model.decode_query(latent, xyt_chunk)
            
            # Move the prediction back to the CPU immediately and store it
            preds_norm_list.append(pred_chunk.squeeze(0).cpu())
            
            # Print progress every few chunks
            if (i // chunk_size) % 10 == 0:
                print(f"  --> Processed {end_idx:,} / {total_points:,} points...")
        
        # Stitch all the CPU chunks back together into one massive array
        preds_norm_full = torch.cat(preds_norm_list, dim=0)
        
        # 4. UN-NORMALIZE BACK TO PHYSICAL SPACE (Done on CPU)
        target_std = dataset.target_std.cpu()
        target_mean = dataset.target_mean.cpu()
        coord_scale = dataset.coord_scale.cpu()
        coord_min = dataset.coord_min.cpu()
        
        preds_phys = (preds_norm_full * target_std) + target_mean
        true_phys = (true_targets_norm_full * target_std) + target_mean
        xyz_phys = (full_xyz_norm * coord_scale) + coord_min

        # ==========================================
        # 5. FIX: ANCHOR THE ABSOLUTE PRESSURE FIELD
        # ==========================================
        # Pressure is the 4th channel (index 3). 
        # Calculate the shift required to align the baselines.
        true_p_mean = true_phys[:, 3].mean()
        pred_p_mean = preds_phys[:, 3].mean()
        pressure_shift = true_p_mean - pred_p_mean
        
        # Apply the shift directly to the prediction tensor
        preds_phys[:, 3] = preds_phys[:, 3] + pressure_shift
        
        print(f"⚓ Pressure Field Anchored (Shift applied: {pressure_shift:+.4f} Pa)")
        print("✅ Full Room Prediction Complete!")
        
        return xyz_phys.numpy(), preds_phys.numpy(), true_phys.numpy()

def plot_cfd_slice(xyz, preds, true_targets=None, z_slice=1.5, tolerance=0.1):
    """
    Plots a 2D slice of the 3D CFD point cloud.
    
    Args:
        xyz: NumPy array of shape (N, 3) containing X, Y, Z coordinates.
        preds: NumPy array of shape (N, 4) containing predicted U, V, W, P.
        true_targets: (Optional) NumPy array of shape (N, 4) for ground truth comparison.
        z_slice: The Z-coordinate (height) to slice the room at.
        tolerance: The +/- range around z_slice to include points in the 2D plot.
    """
    print(f"Extracting 2D slice at Z ≈ {z_slice}m (±{tolerance}m)...")
    
    # 1. Create a mask to filter points near the desired Z-height
    z_coords = xyz[:, 2]
    slice_mask = (z_coords >= z_slice - tolerance) & (z_coords <= z_slice + tolerance)
    
    # Extract the filtered coordinates and predictions
    x_slice = xyz[slice_mask, 0]
    y_slice = xyz[slice_mask, 1]
    
    u_pred = preds[slice_mask, 0]
    v_pred = preds[slice_mask, 1]
    p_pred = preds[slice_mask, 3]
    
    # Calculate velocity magnitude (speed) for coloring the vectors
    speed_pred = np.sqrt(u_pred**2 + v_pred**2)
    
    if len(x_slice) == 0:
        print("Warning: No points found at this Z-slice. Try adjusting the height or tolerance.")
        return

    # 2. Setup the Matplotlib Figure
    fig, (ax1, ax2) = plt.subplots(1, 2, figsize=(18, 7))
    
    # --- Plot 1: Velocity Vector Field (Quiver) ---
    # Using pivot='mid' centers the arrows on the coordinates
    q = ax1.quiver(
        x_slice, y_slice, u_pred, v_pred, speed_pred, 
        cmap='coolwarm', scale=20, pivot='mid', alpha=0.8
    )
    ax1.set_title(f"Predicted Velocity Vectors (Z ≈ {z_slice}m)", fontsize=14)
    ax1.set_xlabel("X (m)", fontsize=12)
    ax1.set_ylabel("Y (m)", fontsize=12)
    ax1.set_aspect('equal')
    fig.colorbar(q, ax=ax1, label='Speed (m/s)')

    # --- Plot 2: Pressure Heatmap (Scatter) ---
    sc = ax2.scatter(
        x_slice, y_slice, c=p_pred, 
        cmap='viridis', s=15, marker='s', alpha=0.8
    )
    ax2.set_title(f"Predicted Absolute Pressure (Z ≈ {z_slice}m)", fontsize=14)
    ax2.set_xlabel("X (m)", fontsize=12)
    ax2.set_ylabel("Y (m)", fontsize=12)
    ax2.set_aspect('equal')
    fig.colorbar(sc, ax=ax2, label='Pressure (Pa)')

    plt.tight_layout()
    plt.show()

xyz_phys, preds_phys, true_phys = predict_full_room_chunked(model, dataset, device)

plot_cfd_slice(xyz_phys, preds_phys, z_slice=1.6, tolerance=0.1)

plot_cfd_slice(xyz_phys, true_phys, z_slice=1.6, tolerance=0.1)