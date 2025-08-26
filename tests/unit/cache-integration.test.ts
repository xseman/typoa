import fs from 'fs'
import path from 'path'
import { strict as assert } from 'node:assert'
import { test, describe, beforeEach, afterEach } from 'node:test'

import { generate } from '../../src'

describe('Cache Integration Tests', () => {
  const testDir = path.resolve(process.cwd(), 'tests/cache-test')
  const cacheDir = '.cache' // Cache directory relative to testDir
  const openapiFile = path.join(testDir, 'openapi.json')
  const routerFile = path.join(testDir, 'router.ts')
  const controllerFile = path.join(testDir, 'controller.ts')
  const tsConfigFile = path.join(testDir, 'tsconfig.json')

  beforeEach(async () => {
    // Cleanup and create test directory
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true })
    }
    fs.mkdirSync(testDir, { recursive: true })

    // Create test controller
    fs.writeFileSync(controllerFile, `
import { Route, Get, Post, Body } from 'typoa'

interface LoginRequest {
  email: string
  password: string
}

interface LoginResponse {
  token: string
}

@Route('/auth')
export class AuthController {
  @Get('/health')
  health(): { status: string } {
    return { status: 'ok' }
  }

  @Post('/login')
  login(@Body() req: LoginRequest): LoginResponse {
    return { token: 'fake-token' }
  }
}
`)

    // Create tsconfig.json
    fs.writeFileSync(tsConfigFile, JSON.stringify({
      compilerOptions: {
        target: 'ES2020',
        module: 'commonjs',
        lib: ['ES2020'],
        experimentalDecorators: true,
        emitDecoratorMetadata: true,
        strict: true,
        esModuleInterop: true,
        skipLibCheck: true,
        forceConsistentCasingInFileNames: true,
        moduleResolution: 'node'
      },
      include: ['*.ts']
    }, null, 2))
  })

  afterEach(() => {
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true })
    }
  })

  test('Should generate correctly on first run (no cache)', async () => {
    await generate({
      tsconfigFilePath: tsConfigFile,
      controllers: [controllerFile],
      root: testDir,
      root: testDir,
      openapi: {
        filePath: openapiFile,
        service: { name: 'test-service', version: '1.0.0' }
      },
      router: {
        filePath: routerFile,
        validateResponse: false
      },
      cache: {
        enabled: true,
        cacheDir: cacheDir,
        verbose: true
      }
    })

    // Verify files were generated
    assert.ok(fs.existsSync(openapiFile))
    assert.ok(fs.existsSync(routerFile))
    assert.ok(fs.existsSync(path.join(testDir, cacheDir, 'cache.json')))

    // Verify router content has correct structure (the bug we fixed)
    const routerContent = fs.readFileSync(routerFile, 'utf-8')
    assert.ok(routerContent.includes('router.get('), 'Should contain router.get(')
    assert.ok(routerContent.includes('router.post('), 'Should contain router.post(')
    assert.ok(routerContent.includes("'/auth/health'"), 'Should contain health endpoint')
    assert.ok(routerContent.includes("'/auth/login'"), 'Should contain login endpoint')
    
    // Should NOT contain malformed syntax
    assert.ok(!routerContent.includes("router.(''"), 'Should not contain malformed router.() calls')
    assert.ok(!routerContent.includes('controller..apply('), 'Should not contain malformed controller..apply() calls')
  })

  test('Should use cache on second run without changes', async () => {
    // First run
    await generate({
      tsconfigFilePath: tsConfigFile,
      controllers: [controllerFile],
      root: testDir,
      root: testDir,
      openapi: { filePath: openapiFile, service: { name: 'test-service', version: '1.0.0' } },
      router: { filePath: routerFile, validateResponse: false },
      cache: { enabled: true, cacheDir: cacheDir, verbose: true }
    })

    const firstRouterContent = fs.readFileSync(routerFile, 'utf-8')
    const firstOpenapiContent = fs.readFileSync(openapiFile, 'utf-8')

    // Second run (should use cache)
    await generate({
      tsconfigFilePath: tsConfigFile,
      controllers: [controllerFile],
      root: testDir,
      root: testDir,
      openapi: { filePath: openapiFile, service: { name: 'test-service', version: '1.0.0' } },
      router: { filePath: routerFile, validateResponse: false },
      cache: { enabled: true, cacheDir: cacheDir, verbose: true }
    })

    const secondRouterContent = fs.readFileSync(routerFile, 'utf-8')
    const secondOpenapiContent = fs.readFileSync(openapiFile, 'utf-8')

    // Content should be identical
    assert.strictEqual(firstRouterContent, secondRouterContent)
    assert.strictEqual(firstOpenapiContent, secondOpenapiContent)
  })

  test('Should perform incremental regeneration when controller changes', async () => {
    // First run
    await generate({
      tsconfigFilePath: tsConfigFile,
      controllers: [controllerFile],
      root: testDir,
      openapi: { filePath: openapiFile, service: { name: 'test-service', version: '1.0.0' } },
      router: { filePath: routerFile, validateResponse: false },
      cache: { enabled: true, cacheDir: cacheDir, verbose: true }
    })

    const firstRouterContent = fs.readFileSync(routerFile, 'utf-8')

    // Modify controller (add new method)
    fs.writeFileSync(controllerFile, `
import { Route, Get, Post, Body } from 'typoa'

interface LoginRequest {
  email: string
  password: string
}

interface LoginResponse {
  token: string
}

@Route('/auth')
export class AuthController {
  @Get('/health')
  health(): { status: string } {
    return { status: 'ok' }
  }

  @Post('/login')
  login(@Body() req: LoginRequest): LoginResponse {
    return { token: 'fake-token' }
  }

  @Get('/status')
  status(): { uptime: number } {
    return { uptime: process.uptime() }
  }
}
`)

    // Second run (should detect changes and regenerate)
    await generate({
      tsconfigFilePath: tsConfigFile,
      controllers: [controllerFile],
      root: testDir,
      openapi: { filePath: openapiFile, service: { name: 'test-service', version: '1.0.0' } },
      router: { filePath: routerFile, validateResponse: false },
      cache: { enabled: true, cacheDir: cacheDir, verbose: true }
    })

    const secondRouterContent = fs.readFileSync(routerFile, 'utf-8')

    // Content should be different (new endpoint added)
    assert.notStrictEqual(firstRouterContent, secondRouterContent)
    
    // Verify new endpoint is present with correct syntax
    assert.ok(secondRouterContent.includes("'/auth/status'"), 'Should contain new status endpoint')
    assert.ok(secondRouterContent.includes('router.get('), 'Should contain router.get() calls')
    
    // Verify no malformed syntax (the bug we fixed)
    assert.ok(!secondRouterContent.includes("router.(''"), 'Should not contain malformed router.() calls')
    assert.ok(!secondRouterContent.includes('controller..apply('), 'Should not contain malformed controller..apply() calls')
  })

  test('Should handle mtime changes without content changes', async () => {
    // First run
    await generate({
      tsconfigFilePath: tsConfigFile,
      controllers: [controllerFile],
      root: testDir,
      openapi: { filePath: openapiFile, service: { name: 'test-service', version: '1.0.0' } },
      router: { filePath: routerFile, validateResponse: false },
      cache: { enabled: true, cacheDir: cacheDir, verbose: true }
    })

    const firstRouterContent = fs.readFileSync(routerFile, 'utf-8')

    // Touch file to change mtime without changing content
    const stats = fs.statSync(controllerFile)
    const newTime = new Date(stats.mtime.getTime() + 10000) // +10 seconds
    fs.utimesSync(controllerFile, newTime, newTime)

    // Second run (should detect mtime change but skip regeneration due to identical content)
    await generate({
      tsconfigFilePath: tsConfigFile,
      controllers: [controllerFile],
      root: testDir,
      openapi: { filePath: openapiFile, service: { name: 'test-service', version: '1.0.0' } },
      router: { filePath: routerFile, validateResponse: false },
      cache: { enabled: true, cacheDir: cacheDir, verbose: true }
    })

    const secondRouterContent = fs.readFileSync(routerFile, 'utf-8')

    // Content should be identical (content hash optimization should skip regeneration)
    assert.strictEqual(firstRouterContent, secondRouterContent)
  })

  test('Should handle implementation-only changes correctly', async () => {
    // First run
    await generate({
      tsconfigFilePath: tsConfigFile,
      controllers: [controllerFile],
      root: testDir,
      openapi: { filePath: openapiFile, service: { name: 'test-service', version: '1.0.0' } },
      router: { filePath: routerFile, validateResponse: false },
      cache: { enabled: true, cacheDir: cacheDir, verbose: true }
    })

    const firstRouterContent = fs.readFileSync(routerFile, 'utf-8')

    // Modify implementation only (method body, not API contract)
    fs.writeFileSync(controllerFile, `
import { Route, Get, Post, Body } from 'typoa'

interface LoginRequest {
  email: string
  password: string
}

interface LoginResponse {
  token: string
}

@Route('/auth')
export class AuthController {
  @Get('/health')
  health(): { status: string } {
    // Changed implementation
    console.log('Health check called')
    return { status: 'ok' }
  }

  @Post('/login')
  login(@Body() req: LoginRequest): LoginResponse {
    // Changed implementation
    console.log('Login called with email:', req.email)
    return { token: 'fake-token' }
  }
}
`)

    // Second run
    await generate({
      tsconfigFilePath: tsConfigFile,
      controllers: [controllerFile],
      root: testDir,
      openapi: { filePath: openapiFile, service: { name: 'test-service', version: '1.0.0' } },
      router: { filePath: routerFile, validateResponse: false },
      cache: { enabled: true, cacheDir: cacheDir, verbose: true }
    })

    const secondRouterContent = fs.readFileSync(routerFile, 'utf-8')

    // Router content should be identical (API contract unchanged)
    assert.strictEqual(firstRouterContent, secondRouterContent)
  })

  test('Should generate valid router syntax with various HTTP methods', async () => {
    // Create controller with multiple HTTP methods
    fs.writeFileSync(controllerFile, `
import { Route, Get, Post, Put, Delete, Patch, Body, Path } from 'typoa'

interface User {
  id: string
  name: string
}

@Route('/users')
export class UserController {
  @Get('/')
  list(): User[] {
    return []
  }

  @Get('/:id')
  get(@Path() id: string): User {
    return { id, name: 'Test' }
  }

  @Post('/')
  create(@Body() user: Omit<User, 'id'>): User {
    return { id: '1', ...user }
  }

  @Put('/:id')
  update(@Path() id: string, @Body() user: User): User {
    return user
  }

  @Patch('/:id')
  patch(@Path() id: string, @Body() data: Partial<User>): User {
    return { id, name: 'Updated' }
  }

  @Delete('/:id')
  delete(@Path() id: string): void {
    // Delete logic
  }
}
`)

    await generate({
      tsconfigFilePath: tsConfigFile,
      controllers: [controllerFile],
      root: testDir,
      openapi: { filePath: openapiFile, service: { name: 'test-service', version: '1.0.0' } },
      router: { filePath: routerFile, validateResponse: false },
      cache: { enabled: true, cacheDir: cacheDir, verbose: true }
    })

    const routerContent = fs.readFileSync(routerFile, 'utf-8')

    // Verify all HTTP methods are generated correctly
    assert.ok(routerContent.includes("router.get('/users'"), 'Should contain GET /users')
    assert.ok(routerContent.includes("router.get('/users/:id'"), 'Should contain GET /users/:id')
    assert.ok(routerContent.includes("router.post('/users'"), 'Should contain POST /users')
    assert.ok(routerContent.includes("router.put('/users/:id'"), 'Should contain PUT /users/:id')
    assert.ok(routerContent.includes("router.patch('/users/:id'"), 'Should contain PATCH /users/:id')
    assert.ok(routerContent.includes("router.delete('/users/:id'"), 'Should contain DELETE /users/:id')

    // Verify no malformed syntax
    assert.ok(!routerContent.includes("router.(''"), 'Should not contain malformed router.() calls')
    assert.ok(!routerContent.includes('controller..apply('), 'Should not contain malformed controller..apply() calls')

    // Test incremental regeneration with this complex controller
    await generate({
      tsconfigFilePath: tsConfigFile,
      controllers: [controllerFile],
      root: testDir,
      openapi: { filePath: openapiFile, service: { name: 'test-service', version: '1.0.0' } },
      router: { filePath: routerFile, validateResponse: false },
      cache: { enabled: true, cacheDir: cacheDir, verbose: true }
    })

    const secondRouterContent = fs.readFileSync(routerFile, 'utf-8')
    
    // After incremental regeneration, syntax should still be correct
    assert.ok(secondRouterContent.includes("router.get('/users'"), 'Should still contain GET /users after cache')
    assert.ok(secondRouterContent.includes("router.post('/users'"), 'Should still contain POST /users after cache')
    assert.ok(!secondRouterContent.includes("router.(''"), 'Should not contain malformed syntax after cache')
  })
})
