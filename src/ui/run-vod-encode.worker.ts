self.onmessage = async ({ data: bitmap }: MessageEvent<ImageBitmap>) => {
  let canvas: OffscreenCanvas | undefined
  try {
    canvas = new OffscreenCanvas(bitmap.width, bitmap.height)
    const context = canvas.getContext('2d')
    if (!context) throw new Error('The VOD encoder could not create a canvas.')
    context.drawImage(bitmap, 0, 0)
    bitmap.close()
    const blob = await canvas.convertToBlob({ type: 'image/png' })
    self.postMessage({ blob })
  } catch (error) {
    bitmap.close()
    self.postMessage({ error: error instanceof Error ? error.message : String(error) })
  } finally { if (canvas) canvas.width = canvas.height = 0 }
}

export {}
