/**
 * Example only: do NOT add a new unauthenticated shipment write endpoint.
 * Use canonicalShipment at your EXISTING authenticated shipment save handler.
 * Node.js implementation proves the browser and server hash the same bytes.
 */
import { createHash } from 'node:crypto'
import { canonicalShipment } from '../../src/shipmentCanonical.mjs'

export function hashShipmentOnServer(shipment, batchId) {
  return '0x' + createHash('sha256').update(canonicalShipment(shipment, batchId), 'utf8').digest('hex')
}

/** Example integration after schema validation and authentication:
 *
 * const submittedHash = hashShipmentOnServer(req.body.shipment, batchId)
 * // client sends tx hash from anchorShipment(batchId, shipment)
 * // fetch the confirmed receipt, check emitter CONTRACT address, event batch ID,
 * // shipmentKey and digest, and check it was emitted by your configured
 * // ShipmentIntegrity contract before saving a verified flag.
 * // Save exactly the hashed shipment fields without post-hash mutation.
 * // Without a matching confirmed receipt, mark the shipment unanchored.
 */
