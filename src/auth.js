import { timingSafeEqual } from 'node:crypto'

function equal(left, right) {
  const leftBuffer = Buffer.from(left)
  const rightBuffer = Buffer.from(right)

  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer)
}

export function basicAuth(username, password) {
  if (!username || !password) {
    throw new Error('BASIC_AUTH_USERNAME and BASIC_AUTH_PASSWORD are required')
  }

  return (request, response, next) => {
    const header = request.get('authorization') || ''
    const [scheme, encoded] = header.split(' ', 2)
    let suppliedUsername = ''
    let suppliedPassword = ''

    if (scheme?.toLowerCase() === 'basic' && encoded) {
      const decoded = Buffer.from(encoded, 'base64').toString('utf8')
      const separator = decoded.indexOf(':')

      if (separator >= 0) {
        suppliedUsername = decoded.slice(0, separator)
        suppliedPassword = decoded.slice(separator + 1)
      }
    }

    if (equal(suppliedUsername, username) && equal(suppliedPassword, password)) {
      next()
      return
    }

    response.set('WWW-Authenticate', 'Basic realm="e9y-api", charset="UTF-8"')
    response.status(401).json({ error: 'Unauthorized' })
  }
}
