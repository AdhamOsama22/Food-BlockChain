/**
 * OrganicTrace shipment hash schema v1. These are the fields currently known
 * from the Consumer's shipment display, plus common shipment details.
 * Expand the schema deliberately if your backend stores additional protected data.
 * Both the record submission and consumer verification MUST use this exact version.
 */
export const SHIPMENT_SCHEMA_VERSION = 'organictrace-shipment-v1'
export const SHIPMENT_FIELDS = Object.freeze([
  'shipmentId', 'source', 'destination', 'quantity', 'unit',
  'transporter', 'dispatchTime', 'arrivalTime', 'temperature',
  'vehicle', 'status', 'notes'
])

function asCanonicalString(value) {
  if (value === undefined || value === null) return ''
  if (value instanceof Date) return value.toISOString()
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value)
  }
  throw new TypeError('Unsupported shipment field type; use a string or number')
}

export function canonicalShipment(shipment, batchId) {
  if (!shipment || typeof shipment !== 'object') throw new TypeError('Shipment object required')
  const id = String(batchId).trim()
  if (!/^[1-9]\d*$/.test(id)) throw new Error('Invalid batch ID')
  const shipmentId = asCanonicalString(shipment.shipmentId).trim()
  if (!shipmentId) throw new Error('Shipment ID required')
  // Positional array guarantees identical byte ordering across JS runtimes.
  // Preserves field spelling; do not normalize/truncate source data unexpectedly.
  return JSON.stringify([SHIPMENT_SCHEMA_VERSION, id, ...SHIPMENT_FIELDS.map(field =>
    field === 'shipmentId' ? shipmentId : asCanonicalString(shipment[field])
  )])
}
