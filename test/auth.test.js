import assert from 'node:assert/strict'
import test from 'node:test'

import { basicAuth } from '../src/auth.js'

function invoke(header) {
  const result = { next: false, status: null, body: null, headers: {} }
  const request = { get: () => header }
  const response = {
    set: (name, value) => { result.headers[name] = value },
    status: (status) => {
      result.status = status
      return response
    },
    json: (body) => { result.body = body },
  }

  basicAuth('ha', 'secret')(request, response, () => { result.next = true })
  return result
}

test('basicAuth accepts the configured credentials', () => {
  const encoded = Buffer.from('ha:secret').toString('base64')
  assert.equal(invoke(`Basic ${encoded}`).next, true)
})

test('basicAuth rejects missing and incorrect credentials', () => {
  const missing = invoke()
  const wrong = invoke(`Basic ${Buffer.from('ha:nope').toString('base64')}`)

  assert.equal(missing.status, 401)
  assert.equal(wrong.status, 401)
  assert.match(missing.headers['WWW-Authenticate'], /^Basic /)
  assert.deepEqual(wrong.body, { error: 'Unauthorized' })
})
