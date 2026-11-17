// Security/robustness checks for the optional local benchmark service.
// Every case drives a real HTTP socket against a loopback listener.
import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { createHandler, startServer } from '../benchmark/server.mjs'

function request(port, { method = 'POST', path = '/api/bench', headers = {}, body = null, host } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path, headers: { ...(host === undefined ? {} : { host }), ...headers } }, res => {
      let text = ''
      res.on('data', c => { text += c })
      res.on('end', () => resolve({ status: res.statusCode, body: text ? JSON.parse(text) : null }))
    })
    req.on('error', reject)
    if (body) req.write(body)
    req.end()
  })
}

test('benchmark service rejects foreign Host, cross-origin requests and bad lengths', async () => {
  const server = await startServer({ port: 0 })
  const port = server.address().port
  try {
    const ok = { 'x-ucz-benchmark': 'yes' }
    assert.equal((await request(port, { headers: { ...ok, host: 'evil.example' }, body: 'x' })).status, 421)
    assert.equal((await request(port, { headers: { ...ok, origin: 'https://evil.example' }, body: 'x' })).status, 403)
    assert.equal((await request(port, { headers: { ...ok, origin: `http://127.0.0.1:${port}` }, body: 'abcde' })).status, 200)
    assert.equal((await request(port, { headers: { ...ok, 'content-length': 'nope' }, body: 'x' })).status, 400)
    assert.equal((await request(port, { headers: ok, body: 'abcdef', method: 'PUT' })).status, 404)
    assert.equal((await request(port, { headers: { 'x-ucz-benchmark': 'no' }, body: 'x' })).status, 404)
    const good = await request(port, { headers: { ...ok, 'x-ucz-level': 'fast' }, body: 'abcdef' })
    assert.equal(good.status, 200)
    assert.equal(good.body.level, 'fast')
    const hostile = await request(port, { headers: { ...ok, 'x-ucz-level': '<script>' }, body: 'abc' })
    assert.equal(hostile.body.level, 'max', 'unknown tiers must not be echoed back')
  } finally { await new Promise(r => server.close(r)) }
})

test('handler reports a busy service instead of queueing forever', async () => {
  const busyRef = { busy: true }
  const server = http.createServer(createHandler({ busyRef }))
  await new Promise(r => server.listen(0, '127.0.0.1', r))
  const port = server.address().port
  try {
    assert.equal((await request(port, { headers: { 'x-ucz-benchmark': 'yes' }, body: 'x' })).status, 429)
  } finally { await new Promise(r => server.close(r)) }
})
