import { describe, expect, it } from 'vitest'
import { createUnavailableSessionAttachmentPort } from '../src/attachment/port.ts'

describe('product attachment port', () => {
  it('fails closed when the official attachment service is not composed', async () => {
    const port = createUnavailableSessionAttachmentPort()

    expect(port.attachmentSnapshot()).toEqual({ available: false })
    await expect(port.prepareImage('panel.png')).rejects.toThrow(
      'Image attachments are unavailable',
    )
    await expect(port.prepareImageBytes!({
      name: 'clipboard.png', mediaType: 'image/png', data: new Uint8Array([1]),
    })).rejects.toThrow('Image attachments are unavailable')
  })
})
