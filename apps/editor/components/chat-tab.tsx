'use client'

import { useChat } from '@ai-sdk/react'
import { DefaultChatTransport } from 'ai'
import { ImageIcon, Send, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

interface Attachment {
  id: string
  file: File
  previewUrl: string
}

function fileToDataUrl(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(file)
  })
}

export function ChatTab() {
  const [input, setInput] = useState('')
  const [attachments, setAttachments] = useState<Attachment[]>([])
  const fileInputRef = useRef<HTMLInputElement>(null)
  const previewUrlsRef = useRef(new Set<string>())
  const { messages, sendMessage, status, error } = useChat({
    transport: new DefaultChatTransport({ api: '/api/chat' }),
  })

  const busy = status === 'submitted' || status === 'streaming'
  const canSend = !busy && (input.trim().length > 0 || attachments.length > 0)

  useEffect(
    () => () => {
      for (const url of previewUrlsRef.current) URL.revokeObjectURL(url)
      previewUrlsRef.current.clear()
    },
    [],
  )

  const addFiles = (files: FileList | null) => {
    if (!files) return
    setAttachments((current) => [
      ...current,
      ...Array.from(files).map((file) => {
        const previewUrl = URL.createObjectURL(file)
        previewUrlsRef.current.add(previewUrl)
        return { id: crypto.randomUUID(), file, previewUrl }
      }),
    ])
    if (fileInputRef.current) fileInputRef.current.value = ''
  }

  const removeAttachment = (id: string) => {
    setAttachments((current) =>
      current.filter((attachment) => {
        if (attachment.id !== id) return true
        URL.revokeObjectURL(attachment.previewUrl)
        previewUrlsRef.current.delete(attachment.previewUrl)
        return false
      }),
    )
  }

  const submit = async () => {
    if (!canSend) return

    const sentAttachments = attachments
    const text = input.trim()
    setInput('')
    setAttachments([])
    for (const attachment of sentAttachments) {
      URL.revokeObjectURL(attachment.previewUrl)
      previewUrlsRef.current.delete(attachment.previewUrl)
    }

    const fileParts = await Promise.all(
      sentAttachments.map(async ({ file }) => ({
        type: 'file' as const,
        mediaType: file.type,
        filename: file.name,
        url: await fileToDataUrl(file),
      })),
    )

    sendMessage({
      role: 'user',
      parts: [...(text ? [{ type: 'text' as const, text }] : []), ...fileParts],
    })
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <div className="border-border border-b px-4 py-3">
        <h2 className="font-semibold text-sm">Chat</h2>
      </div>

      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-3">
        {messages.length === 0 ? (
          <div className="flex h-full items-center justify-center text-center text-muted-foreground text-sm">
            Ask about the scene or attach an image.
          </div>
        ) : (
          messages.map((message) => (
            <div
              className={
                message.role === 'user'
                  ? 'ml-auto max-w-[85%] rounded-lg bg-primary px-3 py-2 text-primary-foreground text-sm'
                  : 'mr-auto max-w-[85%] rounded-lg border border-border bg-muted px-3 py-2 text-sm'
              }
              key={message.id}
            >
              <div className="space-y-2 whitespace-pre-wrap">
                {message.parts.map((part, index) => {
                  if (part.type === 'text')
                    return <p key={`${message.id}-text-${index}`}>{part.text}</p>
                  if (part.type === 'file' && part.mediaType?.startsWith('image/')) {
                    return (
                      <img
                        alt={part.filename ?? 'attachment'}
                        className="max-h-40 rounded-md object-cover"
                        key={`${message.id}-file-${index}`}
                        src={part.url}
                      />
                    )
                  }
                  return null
                })}
              </div>
            </div>
          ))
        )}
        {error && <p className="text-destructive text-xs">{error.message}</p>}
      </div>

      <form
        className="border-border border-t p-3"
        onSubmit={(event) => {
          event.preventDefault()
          void submit()
        }}
      >
        {attachments.length > 0 && (
          <div className="mb-2 flex flex-wrap gap-2">
            {attachments.map((attachment) => (
              <div
                className="group relative h-14 w-14 overflow-hidden rounded-md border border-border"
                key={attachment.id}
              >
                <img alt="" className="h-full w-full object-cover" src={attachment.previewUrl} />
                <button
                  aria-label="Remove image"
                  className="absolute top-1 right-1 rounded-sm bg-background/90 p-0.5 text-foreground opacity-90 hover:bg-background"
                  onClick={() => removeAttachment(attachment.id)}
                  type="button"
                >
                  <X className="h-3 w-3" />
                </button>
              </div>
            ))}
          </div>
        )}

        <textarea
          className="max-h-32 min-h-20 w-full resize-none rounded-md border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={(event) => {
            event.stopPropagation()
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault()
              void submit()
            }
          }}
          placeholder="Message the editor agent"
          value={input}
        />

        <div className="mt-2 flex items-center justify-between">
          <input
            accept="image/*"
            className="hidden"
            multiple
            onChange={(event) => addFiles(event.target.files)}
            ref={fileInputRef}
            type="file"
          />
          <button
            aria-label="Attach image"
            className="rounded-md border border-border p-2 hover:bg-accent disabled:opacity-50"
            disabled={busy}
            onClick={() => fileInputRef.current?.click()}
            type="button"
          >
            <ImageIcon className="h-4 w-4" />
          </button>
          <button
            aria-label="Send message"
            className="rounded-md bg-primary p-2 text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
            disabled={!canSend}
            type="submit"
          >
            <Send className="h-4 w-4" />
          </button>
        </div>
      </form>
    </div>
  )
}
