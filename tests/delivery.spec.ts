import { describe, expect, it } from 'vitest'
import {
  createDshEventDelivery,
  unpackDshEventDelivery,
} from '../src/runtime/delivery.ts'
import { durable } from './fixtures.ts'

describe('runtime event delivery metadata', () => {
  it('unwraps bare events and wrappers with or without a Tool presentation', () => {
    const event = durable(0, {
      type: 'session/observed',
      data: { sourceType: 'delivery-test', ignorable: true },
    })

    expect(unpackDshEventDelivery(event)).toEqual({ event })

    const plain = createDshEventDelivery(event)
    expect(plain).not.toHaveProperty('toolPresentation')
    expect(unpackDshEventDelivery(plain)).toEqual({ event })

    const toolPresentation = { for: 'call' as const, view: null }
    const annotated = createDshEventDelivery(event, toolPresentation)
    expect(unpackDshEventDelivery(annotated)).toEqual({ event, toolPresentation })
  })
})
