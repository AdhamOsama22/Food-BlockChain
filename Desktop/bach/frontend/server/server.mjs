import dns from 'node:dns'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

dns.setServers(['1.1.1.1', '8.8.8.8'])


import express from 'express'
import multer from 'multer'
import dotenv from 'dotenv'
import { MongoClient } from 'mongodb'
import { randomBytes, createHash } from 'node:crypto'
import { Contract, JsonRpcProvider, getAddress, isAddress, verifyMessage } from 'ethers'

dotenv.config()

const app = express()
const PORT = Number(process.env.PORT || 3001)
const HOST = '0.0.0.0'
const CHAIN_ID = 11155111n
// The contract successfully deployed to Ethereum Sepolia.
const CONTRACT_ADDRESS = '0x7ead9cd6c3843AFeaae96e77959d2DC44809429e'

// Server-only RPC: never put private wallet keys in frontend/.env.
// For better reliability use a Sepolia HTTPS endpoint from your RPC provider.
const RPC_URL = process.env.SEPOLIA_RPC_URL || 'https://ethereum-sepolia-rpc.publicnode.com'
const chain = new JsonRpcProvider(RPC_URL, Number(CHAIN_ID), { staticNetwork: true })
const rolesContract = new Contract(CONTRACT_ADDRESS, [
  'function DEFAULT_ADMIN_ROLE() view returns (bytes32)',
  'function CERTIFIER_ROLE() view returns (bytes32)',
  'function hasRole(bytes32 role, address account) view returns (bool)',
  'function batches(uint256) view returns (string productName,string farmName,uint256 harvestDate,address farmer,address currentHolder,bool exists,uint8 stage)',
  'function nextBatchId() view returns (uint256)'
], chain)

// One-use, short-lived wallet challenges; never accept an unsigned claimed admin address.
const challenges = new Map()
const CHALLENGE_LIFETIME_MS = 5 * 60 * 1000
function requireLocalOrigin(req, res, next) {
  if (!allowedOrigins.includes(req.headers.origin)) {
    return res.status(403).json({ error: 'Origin not allowed.' })
  }
  next()
}
function validAddress(value) {
  return typeof value === 'string' && isAddress(value)
}
function cleanName(value) {
  if (typeof value !== 'string') return ''
  return value.trim().replace(/\s+/g, ' ')
}


const allowedOrigins = [
  'http://localhost:5173',
  'http://localhost:5174',
  'http://127.0.0.1:5173',
  'http://127.0.0.1:5174',
  process.env.FRONTEND_URL
].filter(Boolean)

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024
  },
  fileFilter: (req, file, callback) => {
    const isPdf =
      file.mimetype === 'application/pdf' &&
      file.originalname.toLowerCase().endsWith('.pdf')

    if (isPdf) {
      callback(null, true)
    } else {
      callback(new Error('Only PDF files are allowed.'))
    }
  }
})

// MongoDB is accessed only by this server, never directly by React.
let mongoClient = null
let database = null

async function connectMongoDB() {
  const uri = process.env.MONGODB_URI

  if (!uri) {
    throw new Error('MONGODB_URI is missing from the frontend/.env file.')
  }

  const client = new MongoClient(uri, {
    serverSelectionTimeoutMS: 10000
  })

  try {
    await client.connect()
    const db = client.db('organictrace')
    await db.command({ ping: 1 })

    // Existing MongoDB participant names are preserved across this migration.
    // Prepare collections for authenticated API routes.
    // Addresses should be normalized to lower case when storing profiles.
    await db.collection('participants').createIndex(
      { walletAddress: 1 },
      { unique: true }
    )
    await db.collection('batchDetails').createIndex(
      { chainId: 1, contractAddress: 1, batchId: 1 },
      { unique: true }
    )

    mongoClient = client
    database = db
    console.log('MongoDB Atlas connected successfully (database: organictrace).')
  } catch (error) {
    await client.close().catch(() => {})
    throw error
  }
}

// Allow requests from the local React website.
app.use((req, res, next) => {
  const origin = req.headers.origin

  if (origin && allowedOrigins.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin)
    res.setHeader('Vary', 'Origin')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, OPTIONS')
  }

  if (req.method === 'OPTIONS') {
    return res.sendStatus(204)
  }

  next()
})

// Check that both the server and MongoDB are running.
app.use('/api', express.json({ limit: '16kb' }))

app.get('/health', async (req, res) => {
  if (!database) {
    return res.status(503).json({
      status: 'error',
      mongodb: 'disconnected'
    })
  }

  try {
    await database.command({ ping: 1 })
    res.json({ status: 'ok', mongodb: 'connected' })
  } catch {
    res.status(503).json({ status: 'error', mongodb: 'disconnected' })
  }
})

// Public, read-only labels. Previous Hardhat participant names remain available as
// off-chain display labels; they are NOT proof of a role on Sepolia.
// The next successful Admin update associates a profile with Sepolia.
app.get('/api/participants', async (req, res) => {
  try {
    const docs = await database.collection('participants')
      .find({}, { projection: { _id: 0, walletAddress: 1, name: 1 } })
      .limit(1000).toArray()
    res.setHeader('Cache-Control', 'no-store')
    res.json({ participants: docs })
  } catch (error) {
    console.error('Read participants:', error.message)
    res.status(503).json({ error: 'Could not retrieve participant names.' })
  }
})

// Request a short-lived message to sign with the currently selected Admin wallet.
app.post('/api/participants/challenge', requireLocalOrigin, async (req, res) => {
  const { adminAddress: address, walletAddress, name } = req.body || {}
  const sanitized = cleanName(name)
  if (!validAddress(address) || !validAddress(walletAddress) || !sanitized || sanitized.length > 100) {
    return res.status(400).json({ error: 'Invalid admin, participant wallet, or name.' })
  }
  try {
    const role = await rolesContract.DEFAULT_ADMIN_ROLE()
    if (!await rolesContract.hasRole(role, address)) {
      return res.status(403).json({ error: 'The signing wallet is not an on-chain Administrator.' })
    }
    const nonce = randomBytes(24).toString('hex')
    const expiry = Date.now() + CHALLENGE_LIFETIME_MS
    const normalized = getAddress(address)
    const message = [
      'OrganicTrace participant profile authorization',
      `Admin: ${normalized}`,
      `Chain ID: ${CHAIN_ID}`,
      `Contract: ${CONTRACT_ADDRESS}`,
      `Participant wallet: ${getAddress(walletAddress)}`,
      `Participant name: ${sanitized}`,
      `Nonce: ${nonce}`,
      `Expires: ${new Date(expiry).toISOString()}`
    ].join('\n')
    // Remove old challenges for this admin and expired challenges (avoid unbounded growth).
    for (const [key, value] of challenges) {
      if (value.expiry < Date.now() || value.adminAddress === normalized.toLowerCase()) challenges.delete(key)
    }
    challenges.set(nonce, { message, expiry, adminAddress: normalized.toLowerCase(), walletAddress: getAddress(walletAddress).toLowerCase(), name: sanitized })
    res.json({ message, nonce })
  } catch (error) {
    console.error('Admin role check:', error.message)
    res.status(503).json({ error: 'Could not verify the on-chain Administrator on Sepolia. Check the Sepolia RPC connection.' })
  }
})

// Only a fresh signature by a wallet currently holding DEFAULT_ADMIN_ROLE can edit names.
app.put('/api/participants', requireLocalOrigin, async (req, res) => {
  const { walletAddress, name, signature, nonce } = req.body || {}
  if (!validAddress(walletAddress) || typeof signature !== 'string' || typeof nonce !== 'string') {
    return res.status(400).json({ error: 'Invalid participant or authorization information.' })
  }
  const cleaned = cleanName(name)
  if (!cleaned || cleaned.length > 100) {
    return res.status(400).json({ error: 'Participant name must be 1–100 characters.' })
  }
  const challenge = challenges.get(nonce)
  if (!challenge) return res.status(401).json({ error: 'Authorization expired. Please sign again.' })
  challenges.delete(nonce) // one-use even on failed attempts
  if (challenge.expiry < Date.now()) return res.status(401).json({ error: 'Authorization expired.' })
  if (challenge.walletAddress !== getAddress(walletAddress).toLowerCase() || cleaned !== challenge.name) {
    return res.status(403).json({ error: 'Signed participant information does not match the submitted information.' })
  }
  try {
    const signerAddress = verifyMessage(challenge.message, signature).toLowerCase()
    if (signerAddress !== challenge.adminAddress) {
      return res.status(403).json({ error: 'Signature is not from the authorized administrator.' })
    }
    const role = await rolesContract.DEFAULT_ADMIN_ROLE()
    if (!await rolesContract.hasRole(role, signerAddress)) {
      return res.status(403).json({ error: 'Admin permission no longer exists on-chain.' })
    }
    const normalized = getAddress(walletAddress).toLowerCase()
    await database.collection('participants').updateOne(
      { walletAddress: normalized },
      { $set: { name: cleaned, updatedAt: new Date(), chainId: Number(CHAIN_ID), contractAddress: CONTRACT_ADDRESS.toLowerCase() },
        $setOnInsert: { walletAddress: normalized, createdAt: new Date() } },
      { upsert: true }
    )
    res.json({ success: true, participant: { walletAddress: normalized, name: cleaned } })
  } catch (error) {
    console.error('Save participant:', error.message)
    res.status(500).json({ error: 'Could not save participant. Check the admin signature and database connection.' })
  }
})

// Upload a certificate PDF to Pinata. (Existing behavior preserved.)
app.post('/upload', (req, res, next) => {
  const origin = req.headers.origin

  if (!allowedOrigins.includes(origin)) {
    return res.status(403).json({
      error: 'Origin not allowed.'
    })
  }

  next()
}, upload.single('file'), async (req, res) => {
  try {
    const jwt = process.env.PINATA_JWT

    if (!jwt) {
      return res.status(500).json({
        error: 'PINATA_JWT is missing from the .env file.'
      })
    }

    if (!req.file) {
      return res.status(400).json({
        error: 'Please select a PDF file.'
      })
    }

    // Confirm the file begins with the PDF signature.
    const signature = req.file.buffer
      .subarray(0, 5)
      .toString()

    if (signature !== '%PDF-') {
      return res.status(400).json({
        error: 'Invalid PDF file.'
      })
    }

    const formData = new FormData()

    const pdf = new Blob(
      [req.file.buffer],
      { type: 'application/pdf' }
    )

    formData.append(
      'file',
      pdf,
      req.file.originalname
    )

    formData.append('network', 'public')

    const response = await fetch(
      'https://uploads.pinata.cloud/v3/files',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${jwt}`
        },
        body: formData
      }
    )

    const result = await response.json()

    if (!response.ok) {
      console.error(
        'Pinata upload failed:',
        response.status,
        result
      )

      return res.status(502).json({
        error: 'Pinata rejected the upload. Check your JWT and permissions.'
      })
    }

    const cid = result.data?.cid

    if (!cid) {
      return res.status(502).json({
        error: 'Pinata did not return a CID.'
      })
    }

    console.log(
      'PDF uploaded successfully:',
      req.file.originalname
    )

    res.json({
      success: true,
      cid
    })

  } catch (error) {
    console.error('Upload error:', error.message)

    res.status(500).json({
      error: 'PDF upload failed.'
    })
  }
})

// Extra batch information is off-chain; records are identified by chain + contract + batch ID.
// A fresh wallet signature must authorize every write. CORS alone is NOT authorization.
const metadataChallenges = new Map()
const metadataImageUpload = multer({
  storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter(req, file, cb) {
    cb(null, ['image/jpeg', 'image/png', 'image/webp'].includes(file.mimetype))
  }
})
const metadataKey = (id) => ({ chainId: Number(CHAIN_ID), contractAddress: CONTRACT_ADDRESS.toLowerCase(), batchId: String(id) })
const isHexHash = (s) => typeof s === 'string' && /^[0-9a-f]{64}$/.test(s)
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')
const imageMimeFromMagic = (bytes) => {
  if (bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  if (bytes.length > 8 && bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) return 'image/png'
  if (bytes.length > 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'image/webp'
  return null
}
async function verifiedBatch(batchId) {
  if (!/^[1-9]\d*$/.test(String(batchId))) throw new Error('Invalid batch ID.')
  const id = BigInt(batchId)
  if (id >= await rolesContract.nextBatchId()) throw new Error('Batch does not exist on Sepolia.')
  const batch = await rolesContract.batches(id)
  if (!batch.exists) throw new Error('Batch does not exist on Sepolia.')
  return batch
}
function validateMetadata(kind, raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid metadata.')
  const field = (key, max = 150) => {
    if (typeof raw[key] !== 'string') throw new Error(`${key} is required.`)
    const value = raw[key].trim().replace(/\s+/g, ' ')
    if (!value || value.length > max) throw new Error(`${key} must be 1–${max} characters.`)
    return value
  }
  if (kind === 'farm') {
    const location = field('farmLocation', 200)
    const description = typeof raw.description === 'string' ? raw.description.trim() : ''
    if (description.length > 500) throw new Error('Description must be at most 500 characters.')
    const imageHash = raw.imageHash === '' ? '' : raw.imageHash
    if (imageHash !== '' && !isHexHash(imageHash)) throw new Error('Invalid image SHA-256.')
    const suppliedQuantity = raw.quantityKg !== null && raw.quantityKg !== undefined && raw.quantityKg !== ''
    const quantityKg = suppliedQuantity ? Number(raw.quantityKg) : null
    if (suppliedQuantity && (!Number.isFinite(quantityKg) || quantityKg <= 0 || quantityKg > 1e12)) throw new Error('Batch quantity must be positive (kg).')
    return { farmLocation: location, description, imageHash, quantityKg }
  }
  if (kind === 'shipment') {
    const shipmentId = field('shipmentId', 80)
    const source = field('source', 200)
    const destination = field('destination', 200)
    const transporter = field('transporter', 150)
    const dateValue = (key, optional = false) => {
      const value = raw[key]
      if (optional && (value === '' || value == null)) return ''
      if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value) || !Number.isFinite(Date.parse(value + ':00Z'))) throw new Error(`Invalid ${key}.`)
      return value
    }
    const dispatchTime = dateValue('dispatchTime')
    const arrivalTime = dateValue('arrivalTime', true)
    if (arrivalTime && arrivalTime < dispatchTime) throw new Error('Arrival cannot be before dispatch.')
    return { shipmentId, source, destination, transporter, dispatchTime, arrivalTime }
  }
  if (kind === 'certSubmission') {
    const cid = field('cid', 120)
    if (!/^[a-zA-Z0-9]{46,120}$/.test(cid)) throw new Error('Invalid IPFS CID.')
    const hash = field('hash', 66)
    if (!/^0x[0-9a-fA-F]{64}$/.test(hash)) throw new Error('Invalid certificate SHA-256.')
    return { cid, hash: hash.toLowerCase() }
  }
  throw new Error('Unsupported metadata type.')
}
function requireMetadataOrigin(req, res, next) { return requireLocalOrigin(req, res, next) }

// Public, read-only metadata (does not claim blockchain verification).
app.get('/api/batches/:batchId/details', async (req, res) => {
  try {
    const batch = await verifiedBatch(req.params.batchId)
    const doc = await database.collection('batchDetails').findOne(metadataKey(req.params.batchId), { projection: { _id: 0 } })
    res.setHeader('Cache-Control', 'no-store')
    res.json({ chainFarmName: batch.farmName, details: doc ? { farmLocation: doc.farmLocation || '', description: doc.description || '', imageCid: doc.imageCid || '', imageHash: doc.imageHash || '', imageMime: doc.imageMime || '', farmUpdatedBy: doc.farmUpdatedBy || '', quantityKg: doc.quantityKg ?? null, shipments: doc.shipments || [] } : null })
  } catch (err) { res.status(/Invalid batch|does not exist/.test(err.message) ? 404 : 503).json({ error: err.message }) }
})

app.post('/api/batches/:batchId/metadata/challenge', requireMetadataOrigin, async (req, res) => {
  try {
    const { kind, payload, walletAddress } = req.body || {}
    if (!validAddress(walletAddress)) return res.status(400).json({ error: 'Invalid wallet.' })
    const batch = await verifiedBatch(req.params.batchId)
    const signer = getAddress(walletAddress).toLowerCase()
    const allowed = kind === 'farm' || kind === 'certSubmission' ? batch.farmer.toLowerCase() === signer : kind === 'shipment' && batch.currentHolder.toLowerCase() === signer
    if (!allowed) return res.status(403).json({ error: kind === 'certSubmission' ? 'Only the original farmer can submit a certificate.' : kind === 'farm' ? 'Only the batch farmer can edit farm details.' : 'Only the current on-chain holder can record shipment information.' })
    const clean = validateMetadata(kind, payload)
    if (kind === 'shipment') {
      const saved = await database.collection('batchDetails').findOne(metadataKey(req.params.batchId), { projection: { quantityKg: 1 } })
      const registeredQuantity = Number(saved?.quantityKg)
      if (!Number.isFinite(registeredQuantity) || registeredQuantity <= 0) return res.status(409).json({ error: 'Original batch quantity is missing. Ask the batch farmer to save its original quantity first.' })
      clean.quantity = registeredQuantity
      clean.unit = 'kg'
    }
    const nonce = randomBytes(24).toString('hex')
    const expires = Date.now() + CHALLENGE_LIFETIME_MS
    const message = ['OrganicTrace off-chain batch metadata', `Chain: ${CHAIN_ID}`, `Contract: ${CONTRACT_ADDRESS.toLowerCase()}`, `Batch: ${req.params.batchId}`, `Kind: ${kind}`, `Signer: ${signer}`, `Data: ${JSON.stringify(clean)}`, `Nonce: ${nonce}`, `Expiry: ${new Date(expires).toISOString()}`].join('\n')
    for (const [key, challenge] of metadataChallenges) if (challenge.expires <= Date.now()) metadataChallenges.delete(key)
    metadataChallenges.set(nonce, { kind, payload: clean, signer, batchId: req.params.batchId, expires, message })
    res.json({ nonce, message })
  } catch (err) { res.status(400).json({ error: err.message }) }
})

app.put('/api/batches/:batchId/metadata', requireMetadataOrigin, metadataImageUpload.single('image'), async (req, res) => {
  try {
    const { nonce, signature } = req.body || {}
    if (typeof nonce !== 'string' || typeof signature !== 'string') return res.status(400).json({ error: 'Signature required.' })
    const challenge = metadataChallenges.get(nonce)
    if (!challenge) return res.status(401).json({ error: 'Challenge missing or already used.' })
    metadataChallenges.delete(nonce) // single use, even after failure
    if (challenge.expires < Date.now() || challenge.batchId !== req.params.batchId) return res.status(401).json({ error: 'Challenge expired or invalid.' })
    if (verifyMessage(challenge.message, signature).toLowerCase() !== challenge.signer) return res.status(403).json({ error: 'Invalid wallet signature.' })
    const batch = await verifiedBatch(req.params.batchId)
    const currentlyAuthorized = (challenge.kind === 'farm' || challenge.kind === 'certSubmission') ? batch.farmer.toLowerCase() === challenge.signer : batch.currentHolder.toLowerCase() === challenge.signer
    if (!currentlyAuthorized) return res.status(403).json({ error: 'Signer no longer owns the required on-chain authorization.' })
    const key = metadataKey(req.params.batchId)
    const now = new Date()
    if (challenge.kind === 'farm') {
      if (!!req.file !== !!challenge.payload.imageHash) return res.status(400).json({ error: 'Image must match signed request.' })
      let imageFields = {}
      if (req.file) {
        const mime = imageMimeFromMagic(req.file.buffer)
        if (!mime || mime !== req.file.mimetype || sha256(req.file.buffer) !== challenge.payload.imageHash) return res.status(400).json({ error: 'Image type or hash mismatch.' })
        if (!process.env.PINATA_JWT) return res.status(503).json({ error: 'PINATA_JWT is not configured.' })
        const fd = new FormData()
        fd.append('file', new Blob([req.file.buffer], { type: mime }), `batch-${req.params.batchId}-${Date.now()}.${mime.split('/')[1] === 'jpeg' ? 'jpg' : mime.split('/')[1]}`)
        fd.append('network', 'public')
        const uploadResponse = await fetch('https://uploads.pinata.cloud/v3/files', { method: 'POST', headers: { Authorization: `Bearer ${process.env.PINATA_JWT}` }, body: fd })
        if (!uploadResponse.ok) throw new Error('Image upload to Pinata failed.')
        const uploaded = await uploadResponse.json()
        if (!uploaded.data?.cid) throw new Error('Pinata did not return an image CID.')
        imageFields = { imageCid: uploaded.data.cid, imageHash: challenge.payload.imageHash, imageMime: mime }
      }
      const existingFarm = await database.collection('batchDetails').findOne(key, { projection: { quantityKg: 1 } })
      const previousQuantity = Number(existingFarm?.quantityKg)
      if (Number.isFinite(previousQuantity) && previousQuantity > 0 && challenge.payload.quantityKg != null && challenge.payload.quantityKg !== previousQuantity) {
        return res.status(409).json({ error: 'Original batch quantity cannot be changed after it has been saved.' })
      }
      const quantityField = challenge.payload.quantityKg != null && !(Number.isFinite(previousQuantity) && previousQuantity > 0)
        ? { quantityKg: challenge.payload.quantityKg } : {}
      await database.collection('batchDetails').updateOne(key, { $set: { farmLocation: challenge.payload.farmLocation, description: challenge.payload.description, farmUpdatedBy: challenge.signer, farmUpdatedAt: now, ...quantityField, ...imageFields }, $setOnInsert: { ...key, createdAt: now } }, { upsert: true })
    } else if (challenge.kind === 'certSubmission') {
      if (req.file) return res.status(400).json({ error: 'Unexpected image.' })
      // A farmer can submit documentation, but only CERTIFIER_ROLE can register it on-chain.
      await database.collection('batchDetails').updateOne(key, {
        $set: { pendingCertification: { ...challenge.payload, farmer: challenge.signer, submittedAt: now.toISOString() } },
        $setOnInsert: { ...key, createdAt: now }
      }, { upsert: true })
    } else {
      const existing = await database.collection('batchDetails').findOne(key, { projection: { shipments: 1 } })
      if (existing?.shipments?.some(x => x.shipmentId === challenge.payload.shipmentId)) return res.status(409).json({ error: 'Shipment ID already exists for this batch.' })
      const entry = { ...challenge.payload, recordedBy: challenge.signer, recordedAt: now.toISOString(), recordId: randomBytes(12).toString('hex'), custodyStageAtRecording: Number(batch.stage), recordType: 'off-chain' }
      await database.collection('batchDetails').updateOne(key, { $push: { shipments: entry }, $setOnInsert: { ...key, createdAt: now } }, { upsert: true })
    }
    res.json({ success: true })
  } catch (err) { console.error('Batch metadata:', err.message); res.status(500).json({ error: 'Could not save batch metadata: ' + err.message }) }
})


// Review queue is available only to an on-chain CERTIFIER_ROLE holder via one-use signed challenge.
const reviewChallenges = new Map()
app.post('/api/certification-submissions/challenge', requireLocalOrigin, async (req, res) => {
  try {
    const wallet = req.body?.walletAddress
    if (!validAddress(wallet)) return res.status(400).json({ error: 'Invalid wallet.' })
    const signer = getAddress(wallet).toLowerCase()
    if (!await rolesContract.hasRole(await rolesContract.CERTIFIER_ROLE(), signer)) return res.status(403).json({ error: 'Certifier role required.' })
    const nonce = randomBytes(24).toString('hex')
    const expires = Date.now() + CHALLENGE_LIFETIME_MS
    const message = ['OrganicTrace certifier submissions review', `Chain: ${CHAIN_ID}`, `Contract: ${CONTRACT_ADDRESS.toLowerCase()}`, `Signer: ${signer}`, `Nonce: ${nonce}`, `Expires: ${new Date(expires).toISOString()}`].join('\n')
    for (const [key, item] of reviewChallenges) if (item.expires <= Date.now()) reviewChallenges.delete(key)
    reviewChallenges.set(nonce, { signer, expires, message })
    res.json({ nonce, message })
  } catch (err) { res.status(503).json({ error: 'Could not verify certifier role.' }) }
})
app.post('/api/certification-submissions/list', requireLocalOrigin, async (req, res) => {
  try {
    const { nonce, signature } = req.body || {}
    if (typeof nonce !== 'string' || typeof signature !== 'string') return res.status(400).json({ error: 'Signature required.' })
    const challenge = reviewChallenges.get(nonce)
    if (!challenge) return res.status(401).json({ error: 'Invalid or already used challenge.' })
    reviewChallenges.delete(nonce)
    if (challenge.expires < Date.now() || verifyMessage(challenge.message, signature).toLowerCase() !== challenge.signer) return res.status(401).json({ error: 'Invalid or expired signature.' })
    if (!await rolesContract.hasRole(await rolesContract.CERTIFIER_ROLE(), challenge.signer)) return res.status(403).json({ error: 'Certifier role required.' })
    const docs = await database.collection('batchDetails').find(
      { chainId: Number(CHAIN_ID), contractAddress: CONTRACT_ADDRESS.toLowerCase(), pendingCertification: { $exists: true } },
      { projection: { _id: 0, batchId: 1, pendingCertification: 1 } }
    ).limit(200).toArray()
    res.setHeader('Cache-Control', 'no-store')
    res.json({ submissions: docs.map(doc => ({ batchId: doc.batchId, ...doc.pendingCertification })) })
  } catch (err) { res.status(503).json({ error: 'Cannot load certificate submissions.' }) }
})

// Serve the Vite production build from frontend/dist on the same public domain.
// This is independent of the API routes and leaves /health available for EthioDeploy.
const frontendDist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../dist')
app.use(express.static(frontendDist, { index: 'index.html' }))

// React client-side routes should load the SPA, but unknown API routes and
// missing asset files must return 404 rather than index.html.
app.get(/.*/, (req, res, next) => {
  if (req.path === '/upload' || req.path.startsWith('/api/') || req.path === '/api' ||
      req.path === '/health' || path.posix.extname(req.path)) {
    return next()
  }
  res.sendFile(path.join(frontendDist, 'index.html'), (error) => {
    if (error) next(error)
  })
})

// Handle upload errors.
app.use((error, req, res, next) => {
  console.error('Request error:', error.message)

  res.status(400).json({
    error: error.message || 'Upload failed.'
  })
})

async function start() {
  try {
    // Check the ACTUAL remote chain ID, rather than trusting a static provider hint.
    const reportedChainId = BigInt(await chain.send('eth_chainId', []))
    if (reportedChainId !== CHAIN_ID) {
      throw new Error(`Sepolia RPC returned chain ID ${reportedChainId}; expected ${CHAIN_ID}.`)
    }
    const code = await chain.getCode(CONTRACT_ADDRESS)
    if (!code || code === '0x') {
      throw new Error('OrganicTrace contract was not found at the configured Sepolia address.')
    }
    console.log('Sepolia RPC verified (chain ID 11155111, contract available).')

    await connectMongoDB()

    app.listen(PORT, HOST, () => {
      console.log('----------------------------------------')
      console.log('OrganicTrace Sepolia + Pinata + MongoDB Server')
      console.log(`Running at http://${HOST}:${PORT}`)
      console.log('----------------------------------------')
    })
  } catch (error) {
    // Do not print the connection URI or database password.
    console.error('Backend startup failed:', error.message)
    console.error('Check SEPOLIA_RPC_URL, Sepolia access, MONGODB_URI, Atlas Network Access, and database permissions.')
    process.exitCode = 1
  }
}

async function shutdown() {
  if (mongoClient) await mongoClient.close()
  process.exit(0)
}

process.once('SIGINT', shutdown)
process.once('SIGTERM', shutdown)

start()
