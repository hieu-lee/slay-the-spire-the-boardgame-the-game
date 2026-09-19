// Two jobs include bitmap creation: callers must drain a job before submitting
// a third, rather than retaining an unbounded queue of full-resolution canvases.
export function createRunVodEncoder() {
  type Job = { resolve: (blob: Blob) => void; reject: (error: Error) => void }
  const slots: { worker?: Worker; job?: Job }[] = [{}, {}]
  let stopped: Error | undefined
  const stop = (error: Error) => {
    stopped = error
    for (const slot of slots) {
      slot.worker?.terminate()
      slot.job?.reject(error)
      slot.job = undefined
    }
  }
  if (typeof Worker !== 'undefined' && typeof OffscreenCanvas !== 'undefined' &&
      typeof createImageBitmap !== 'undefined' && 'convertToBlob' in OffscreenCanvas.prototype) {
    try {
      for (const slot of slots) {
        const worker = new Worker(new URL('./run-vod-encode.worker.ts', import.meta.url), { type: 'module' })
        slot.worker = worker
        worker.onmessage = ({ data }: MessageEvent<{ blob?: Blob; error?: string }>) => {
          if (data.error || !(data.blob instanceof Blob)) {
            stop(new Error(data.error || 'The VOD frame encoder returned no image.'))
            return
          }
          const job = slot.job
          slot.job = undefined
          job?.resolve(data.blob)
        }
        worker.onerror = (event) => {
          event.preventDefault()
          stop(new Error(event.message || 'The VOD frame encoder failed.'))
        }
        worker.onmessageerror = () => stop(new Error('The VOD frame encoder returned an unreadable image.'))
      }
    } catch {
      for (const slot of slots) { slot.worker?.terminate(); slot.worker = undefined }
    }
  }
  return {
    encode(canvas: HTMLCanvasElement): Promise<Blob> {
      if (stopped) return Promise.reject(stopped)
      const slot = slots.find((candidate) => !candidate.job)
      if (!slot) return Promise.reject(new Error('Drain a VOD encoding job before submitting more than two frames.'))
      return new Promise<Blob>((resolve, reject) => {
        slot.job = { resolve, reject }
        if (slot.worker) {
          void createImageBitmap(canvas).then((bitmap) => {
            try {
              if (!stopped) slot.worker!.postMessage(bitmap, [bitmap])
            } finally { bitmap.close() }
          }).catch((error) => stop(error instanceof Error ? error : new Error(String(error))))
        } else {
          // Avoid HTMLCanvasElement.toBlob's idle-scheduling stalls.
          try {
            void fetch(canvas.toDataURL('image/png')).then((response) => response.blob()).then((blob) => {
              const job = slot.job
              slot.job = undefined
              job?.resolve(blob)
            }).catch((error) => stop(error instanceof Error ? error : new Error(String(error))))
          } catch (error) { stop(error instanceof Error ? error : new Error(String(error))) }
        }
      })
    },
    close() { stop(new Error('The VOD frame encoder was closed.')) },
  }
}
