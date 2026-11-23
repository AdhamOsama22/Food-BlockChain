import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { canonicalShipment } from '../src/shipmentCanonical.mjs'
const sample = { shipmentId: 'SHIP-7-1', source: 'Farm', destination: 'Distributor', quantity: 100, unit: 'kg', transporter: 'Ali' }
const fingerprint = s => createHash('sha256').update(canonicalShipment(s, 7)).digest('hex')

test('same shipment yields deterministic canonical bytes', () => {
  assert.equal(canonicalShipment(sample, 7), canonicalShipment({...sample}, '7'))
})
test('quantity tampering produces different SHA-256 hash', () => {
  assert.notEqual(fingerprint(sample), fingerprint({...sample,quantity: 500}))
})
test('shipment order does not affect fingerprint', () => {
  assert.equal(fingerprint(sample), fingerprint({transporter:'Ali',quantity:100,unit:'kg',destination:'Distributor',source:'Farm',shipmentId:'SHIP-7-1'}))
})
test('batch ID is bound to the fingerprint', () => {
  assert.notEqual(fingerprint(sample), createHash('sha256').update(canonicalShipment(sample, 8)).digest('hex'))
})
test('missing ID rejected', () => {
  assert.throws(() => canonicalShipment({...sample, shipmentId: ''},7))
})
