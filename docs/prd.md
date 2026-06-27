# **Agentic HVAC Fast Layout Optimizer**

## **1\. Product Name**

**HVAC-X Fast Layout Optimizer**

## **2\. Product Objective**

Develop an agentic AI workflow that optimizes HVAC airflow layout in a **fixed room/domain** using a fast prediction engine. The system evaluates multiple configurations of **3 inlets and 3 outlets**, where the main design variables are:

* Inlet spacing  
* Outlet spacing  
* Inlet size  
* Outlet size

The system does not perform CFD validation in the MVP. It focuses on rapid screening, ranking, and recommendation based on comfort, airflow quality, and energy-related indicators.

---

## **3\. Scope**

### **In Scope**

* Fixed room geometry  
* Fixed number of air terminals: **3 inlets \+ 3 outlets**  
* Variable inlet/outlet spacing  
* Variable inlet/outlet size  
* Fast prediction of airflow and thermal performance  
* Multi-objective ranking  
* Final recommended configuration

### **Out of Scope**

* CFD validation  
* Changing room geometry  
* Changing number of inlets/outlets  
* Detailed duct network design  
* Full HVAC equipment sizing  
* Real-time control optimization

---

## **4\. Target Users**

| User | Main Need |
| ----- | ----- |
| HVAC engineer | Quickly identify good inlet/outlet arrangements |
| CFD/simulation engineer | Reduce unnecessary detailed simulations |
| Building designer | Compare practical design options |
| Facility owner | Improve comfort and reduce energy use |

---

## **5\. Input Specification**

| Input Group | Required Input |
| ----- | ----- |
| Fixed domain | Room length, width, height, wall/door/window position |
| Load condition | Occupancy, heat sources, equipment load, lighting load |
| HVAC layout | 3 inlet locations, 3 outlet locations |
| Design variables | Inlet spacing, outlet spacing, inlet size, outlet size |
| Boundary conditions | Supply temperature, airflow rate, return pressure/flow assumption |
| Constraints | Minimum spacing, maximum size, allowed wall/ceiling zones |
| Targets | Comfort, temperature uniformity, airflow coverage, energy efficiency |

---

## **6\. Design Variables**

| Variable | Description | Example |
| ----- | ----- | ----- |
| Inlet spacing | Distance between 3 supply inlets | 0.8–2.0 m |
| Outlet spacing | Distance between 3 return outlets | 0.8–2.0 m |
| Inlet size | Width/diameter/area of each inlet | 0.05–0.20 m² |
| Outlet size | Width/diameter/area of each outlet | 0.05–0.25 m² |
| Inlet position offset | Position shift along allowed installation line | x/y coordinate |
| Outlet position offset | Position shift along allowed installation line | x/y coordinate |

---

## **7\. Output Specification**

| Output | Description |
| ----- | ----- |
| Structured design brief | Fixed room, load, constraint, and target definition |
| Candidate layout set | Generated combinations of 3 inlets and 3 outlets |
| Prediction results | Estimated airflow, temperature, comfort, and energy indicators |
| Ranking table | Candidate score based on multi-objective criteria |
| Best configuration | Recommended inlet/outlet spacing and sizing |
| Design report | Summary of assumptions, best layout, and performance comparison |

---

## **8\. Agent Workflow**

User Requirement  
→ Fixed Domain Setup Agent  
→ Design Space Agent  
→ Candidate Generation Agent  
→ Fast Prediction Agent  
→ Ranking Agent  
→ Report Agent

---

## **9\. Agent Specification**

| Agent | Role | Input | Output |
| ----- | ----- | ----- | ----- |
| Fixed Domain Setup Agent | Defines fixed room and boundary conditions | Room geometry, load, HVAC assumptions | Structured design brief |
| Design Space Agent | Defines spacing and sizing ranges | Design brief, constraints | Design variable table |
| Candidate Generation Agent | Creates multiple 3-inlet/3-outlet layouts | Variable ranges | Candidate configurations |
| Fast Prediction Agent | Estimates performance without CFD validation | Candidate layouts, surrogate model | Predicted metrics |
| Ranking Agent | Scores and ranks candidates | Prediction results | Top-ranked configurations |
| Report Agent | Generates final design summary | Ranking results | Recommended layout report |

---

## **10\. Fast Prediction Engine Specification**

### **Purpose**

Rapidly estimate the performance of each 3-inlet/3-outlet configuration in a fixed room domain.

### **Input**

| Input | Description |
| ----- | ----- |
| Fixed room geometry | Predefined room/domain |
| Inlet layout | Position, spacing, size of 3 inlets |
| Outlet layout | Position, spacing, size of 3 outlets |
| Supply condition | Airflow rate and supply temperature |
| Heat-load map | People, equipment, lighting, process heat |
| Occupied zone | Region used for comfort evaluation |

### **Output**

| Output Metric | Description |
| ----- | ----- |
| Temperature uniformity | Spatial temperature variation in occupied zone |
| Airflow coverage | Percentage of occupied zone with acceptable velocity |
| Dead-zone risk | Area with very low air velocity |
| Short-circuiting risk | Direct flow from inlet to outlet without room mixing |
| Comfort score | PMV or simplified comfort index |
| Energy indicator | Estimated cooling/ventilation effort |
| Overall score | Weighted performance score |

---

## **11\. Ranking Logic**

The system ranks each candidate using a weighted score:

Total Score \=  
w1 × Comfort Score  
\+ w2 × Temperature Uniformity Score  
\+ w3 × Airflow Coverage Score  
\+ w4 × Energy Score  
\+ w5 × Practicality Score

### **Default Weights**

| Metric | Weight |
| ----- | ----- |
| Comfort | 30% |
| Temperature uniformity | 25% |
| Airflow coverage | 20% |
| Energy indicator | 15% |
| Practicality | 10% |

---

## **12\. Functional Requirements**

| ID | Requirement |
| ----- | ----- |
| FR-01 | The system shall accept a fixed room/domain as input. |
| FR-02 | The system shall keep the number of inlets fixed at 3\. |
| FR-03 | The system shall keep the number of outlets fixed at 3\. |
| FR-04 | The system shall vary inlet spacing, outlet spacing, inlet size, and outlet size. |
| FR-05 | The system shall generate feasible candidate configurations. |
| FR-06 | The system shall evaluate candidates using a fast prediction engine. |
| FR-07 | The system shall rank candidates using multi-objective criteria. |
| FR-08 | The system shall recommend the best inlet/outlet spacing and sizing. |
| FR-09 | The system shall generate a concise engineering report. |

---

## **13\. Non-Functional Requirements**

| Category | Requirement |
| ----- | ----- |
| Speed | Screen 100–1,000 candidates within minutes |
| Simplicity | No CFD validation required in MVP |
| Explainability | Ranking must show why each candidate performs well or poorly |
| Flexibility | User can modify spacing, sizing, and scoring weights |
| Reusability | Same workflow can be reused for office, lab, classroom, or industrial room |
| Practicality | Generated layouts must satisfy installation constraints |

---

## **14\. MVP Scope**

| Item | MVP Specification |
| ----- | ----- |
| Domain | Fixed rectangular or simplified room |
| Air terminals | 3 inlets and 3 outlets |
| Variables | Spacing and sizing only |
| Prediction model | Surrogate/ML/ROM-based fast evaluator |
| Candidate number | 100–1,000 configurations |
| Final output | Ranked table and recommended layout |
| Validation | Not included in MVP |

---

## **15\. Success Metrics**

| KPI | Target |
| ----- | ----- |
| Candidate screening speed | 100+ configurations within minutes |
| Design variables handled | Inlet/outlet spacing and sizing |
| Best layout identification | Top 3 candidates clearly ranked |
| Comfort improvement | Better temperature and airflow coverage than baseline |
| Energy indicator improvement | Lower estimated cooling/ventilation effort |
| Workflow simplicity | No manual CFD setup required |

---

## **16\. Final Product Statement**

HVAC-X Fast Layout Optimizer is an agentic AI tool for early-stage HVAC layout optimization in a fixed room domain. It keeps the room geometry fixed and evaluates multiple configurations of 3 inlets and 3 outlets by varying only inlet/outlet spacing and sizing. A fast prediction engine estimates comfort, airflow quality, temperature uniformity, and energy indicators, enabling rapid multi-objective ranking and final layout recommendation without CFD validation in the MVP.
