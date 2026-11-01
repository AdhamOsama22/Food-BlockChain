
import express from 'express'
import multer from 'multer'
import dotenv from 'dotenv'

dotenv.config()

const app = express()
const PORT = 3001

const allowedOrigins = [
  'http://localhost:5173',
  'http://localhost:5174',
  'http://127.0.0.1:5173',
  'http://127.0.0.1:5174'
]

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

// Allow requests from the local React website.
app.use((req, res, next) => {
  const origin = req.headers.origin

  if (origin && allowedOrigins.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin)
    res.setHeader('Vary', 'Origin')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  }

  if (req.method === 'OPTIONS') {
    return res.sendStatus(204)
  }

  next()
})

// Check that the server is running.
app.get('/health', (req, res) => {
  res.json({ status: 'ok' })
})

// Upload a certificate PDF to Pinata.
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

// Handle upload errors.
app.use((error, req, res, next) => {
  console.error('Request error:', error.message)

  res.status(400).json({
    error: error.message || 'Upload failed.'
  })
})

// Start the server.
app.listen(PORT, '127.0.0.1', () => {
  console.log('----------------------------------------')
  console.log('OrganicTrace Pinata Upload Server')
  console.log(`Running at http://127.0.0.1:${PORT}`)
  console.log('----------------------------------------')
})
