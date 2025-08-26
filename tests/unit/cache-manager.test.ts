import fs from 'fs'
import path from 'path'
import { strict as assert } from 'node:assert'
import { test, describe, beforeEach, afterEach } from 'node:test'

import { CacheManager, TypeoaCache, DependencyGraph } from '../../src/cache'
import { createSpec } from '../../src/openapi'

describe('CacheManager', () => {
  const testCacheDir = '.test-cache'
  let cacheManager: CacheManager
  let testCache: TypeoaCache

  beforeEach(() => {
    cacheManager = new CacheManager(testCacheDir, process.cwd())
    testCache = {
      version: '1.0.0',
      types: new Map([
        ['User', {
          id: 'User',
          signature: 'User:interface:email:string,password:string',
          schema: { type: 'object', properties: { email: { type: 'string' }, password: { type: 'string' } } },
          dependencies: new Set(['string']),
          dependents: new Set(['LoginReq']),
          sourceFile: '/test/entities/user.ts',
          lastModified: Date.now()
        }]
      ]),
      controllers: new Map([
        ['AuthController#login', {
          id: 'AuthController#login',
          signature: 'login(req:LoginReq):Promise<LoginRes>',
          implementationHash: 'abc123',
          metadata: {
            name: 'login',
            endpoint: '/jwt/sign-in',
            verb: 'post',
            security: [],
            params: [],
            body: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/LoginReq' } } } },
            responses: { '200': { description: 'Ok', content: { 'application/json': { schema: { $ref: '#/components/schemas/LoginRes' } } } } },
            validateResponse: true,
            contentType: 'application/json'
          },
          sourceFile: '/test/controllers/auth.controller.ts',
          lastModified: Date.now(),
          route: '/jwt/sign-in',
          httpMethod: 'POST',
          decorators: new Map(),
          parameterTypes: new Map(),
          typeDependencies: new Set(['LoginReq', 'LoginRes'])
        }]
      ]),
      files: new Map([
        ['/test/controllers/auth.controller.ts', {
          path: '/test/controllers/auth.controller.ts',
          lastModified: Date.now(),
          contentHash: 'def456',
          exportedTypes: new Map(),
          controllers: new Set(['AuthController']),
          imports: new Set(['/test/entities/user.ts']),
          apiSignature: 'controller:AuthController:/jwt'
        }]
      ]),
      dependencies: new DependencyGraph(),
      openApiSpec: createSpec({ name: 'test-service', version: '1.0.0' }),
      routerContent: 'export function bindToRouter(router) { /* generated code */ }',
      lastFullGeneration: Date.now()
    }

    // Ensure clean state
    if (fs.existsSync(testCacheDir)) {
      fs.rmSync(testCacheDir, { recursive: true, force: true })
    }
  })

  afterEach(() => {
    // Cleanup
    if (fs.existsSync(testCacheDir)) {
      fs.rmSync(testCacheDir, { recursive: true, force: true })
    }
  })

  test('Should return null when no cache exists', async () => {
    const result = await cacheManager.load()
    assert.strictEqual(result, null)
  })

  test('Should save and load cache correctly', async () => {
    await cacheManager.save(testCache)
    const loaded = await cacheManager.load()

    assert.ok(loaded)
    assert.strictEqual(loaded.version, testCache.version)
    assert.strictEqual(loaded.routerContent, testCache.routerContent)
    assert.strictEqual(loaded.lastFullGeneration, testCache.lastFullGeneration)

    // Check types map
    assert.strictEqual(loaded.types.size, 1)
    const userType = loaded.types.get('User')!
    assert.strictEqual(userType.id, 'User')
    assert.strictEqual(userType.signature, 'User:interface:email:string,password:string')
    assert.ok(userType.dependencies instanceof Set)
    assert.ok(userType.dependents instanceof Set)
    assert.ok(userType.dependencies.has('string'))
    assert.ok(userType.dependents.has('LoginReq'))

    // Check controllers map
    assert.strictEqual(loaded.controllers.size, 1)
    const controller = loaded.controllers.get('AuthController#login')!
    assert.strictEqual(controller.id, 'AuthController#login')
    assert.strictEqual(controller.metadata.name, 'login')
    assert.strictEqual(controller.metadata.verb, 'post')
    assert.strictEqual(controller.metadata.endpoint, '/jwt/sign-in')
    assert.ok(controller.parameterTypes instanceof Map)
    assert.ok(controller.typeDependencies instanceof Set)
    assert.ok(controller.decorators instanceof Map)

    // Check files map
    assert.strictEqual(loaded.files.size, 1)
    const file = loaded.files.get('/test/controllers/auth.controller.ts')!
    assert.ok(file.exportedTypes instanceof Map)
    assert.ok(file.controllers instanceof Set)
    assert.ok(file.imports instanceof Set)
    assert.ok(file.controllers.has('AuthController'))
    assert.ok(file.imports.has('/test/entities/user.ts'))
  })

  test('Should handle cache version incompatibility', async () => {
    // Save cache with current version
    await cacheManager.save(testCache)

    // Manually modify the cache file to have an incompatible version
    const cacheFile = path.join(process.cwd(), testCacheDir, 'cache.json')
    const content = JSON.parse(fs.readFileSync(cacheFile, 'utf-8'))
    content.version = '0.5.0' // Old version
    fs.writeFileSync(cacheFile, JSON.stringify(content))

    // Should return null for incompatible version
    const loaded = await cacheManager.load()
    assert.strictEqual(loaded, null)
  })

  test('Should handle corrupted cache file gracefully', async () => {
    // Create corrupted cache file
    const cacheDir = path.join(process.cwd(), testCacheDir)
    fs.mkdirSync(cacheDir, { recursive: true })
    const cacheFile = path.join(cacheDir, 'cache.json')
    fs.writeFileSync(cacheFile, '{ invalid json content')

    const loaded = await cacheManager.load()
    assert.strictEqual(loaded, null)
  })

  test('Should clear cache directory', async () => {
    await cacheManager.save(testCache)
    
    // Verify cache exists
    assert.ok(fs.existsSync(path.join(process.cwd(), testCacheDir)))
    
    await cacheManager.clear()
    
    // Verify cache is cleared
    assert.ok(!fs.existsSync(path.join(process.cwd(), testCacheDir)))
  })

  test('Should check cache existence', async () => {
    // Initially no cache
    assert.strictEqual(await cacheManager.exists(), false)
    
    // After saving
    await cacheManager.save(testCache)
    assert.strictEqual(await cacheManager.exists(), true)
    
    // After clearing
    await cacheManager.clear()
    assert.strictEqual(await cacheManager.exists(), false)
  })

  test('Should handle empty collections correctly', async () => {
    const emptyCacheData: TypeoaCache = {
      version: '1.0.0',
      types: new Map(),
      controllers: new Map(),
      files: new Map(),
      dependencies: new DependencyGraph(),
      openApiSpec: createSpec({ name: 'empty-service', version: '1.0.0' }),
      routerContent: '',
      lastFullGeneration: Date.now()
    }

    await cacheManager.save(emptyCacheData)
    const loaded = await cacheManager.load()

    assert.ok(loaded)
    assert.strictEqual(loaded.types.size, 0)
    assert.strictEqual(loaded.controllers.size, 0)
    assert.strictEqual(loaded.files.size, 0)
    assert.ok(loaded.types instanceof Map)
    assert.ok(loaded.controllers instanceof Map)
    assert.ok(loaded.files instanceof Map)
  })

  test('Should preserve file paths with special characters', async () => {
    const specialPath = '/test/controllers/special-file@name.controller.ts'
    testCache.files.set(specialPath, {
      path: specialPath,
      lastModified: Date.now(),
      contentHash: 'special123',
      exportedTypes: new Map(),
      controllers: new Set(['SpecialController']),
      imports: new Set(),
      apiSignature: 'special'
    })

    await cacheManager.save(testCache)
    const loaded = await cacheManager.load()

    assert.ok(loaded)
    assert.ok(loaded.files.has(specialPath))
    const file = loaded.files.get(specialPath)!
    assert.strictEqual(file.contentHash, 'special123')
    assert.ok(file.controllers.has('SpecialController'))
  })

  test('Should handle large cache data', async () => {
    // Create cache with many entries
    for (let i = 0; i < 100; i++) {
      testCache.types.set(`Type${i}`, {
        id: `Type${i}`,
        signature: `Type${i}:interface:prop:string`,
        schema: { type: 'object', properties: { prop: { type: 'string' } } },
        dependencies: new Set([`Dep${i}`]),
        dependents: new Set([`Dependent${i}`]),
        sourceFile: `/test/types/type${i}.ts`,
        lastModified: Date.now()
      })

      testCache.controllers.set(`Controller${i}#method${i}`, {
        id: `Controller${i}#method${i}`,
        signature: `method${i}():void`,
        implementationHash: `hash${i}`,
        metadata: {
          name: `method${i}`,
          endpoint: `/api/endpoint${i}`,
          verb: 'get',
          security: [],
          params: [],
          responses: {},
          validateResponse: false,
          contentType: 'application/json'
        },
        sourceFile: `/test/controllers/controller${i}.ts`,
        lastModified: Date.now(),
        route: `/api/endpoint${i}`,
        httpMethod: 'GET',
        decorators: new Map(),
        parameterTypes: new Map(),
        typeDependencies: new Set()
      })
    }

    await cacheManager.save(testCache)
    const loaded = await cacheManager.load()

    assert.ok(loaded)
    assert.strictEqual(loaded.types.size, 101) // 100 + original 1
    assert.strictEqual(loaded.controllers.size, 101) // 100 + original 1
    
    // Verify specific entries
    assert.ok(loaded.types.has('Type50'))
    assert.ok(loaded.controllers.has('Controller50#method50'))
  })
})
