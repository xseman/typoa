import fs from 'fs'
import path from 'path'
import { strict as assert } from 'node:assert'
import { test, describe, beforeEach, afterEach } from 'node:test'

import { generate } from '../../src'

describe('Router Generation Bug Fix Tests', () => {
  const testDir = path.resolve(process.cwd(), 'tests/router-bug-test')
  const cacheDir = '.cache' // Cache directory relative to testDir
  const openapiFile = path.join(testDir, 'openapi.json')
  const routerFile = path.join(testDir, 'router.ts')
  const controllerFile = path.join(testDir, 'auth.controller.ts')
  const tsConfigFile = path.join(testDir, 'tsconfig.json')

  beforeEach(async () => {
    // Cleanup and create test directory
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true })
    }
    fs.mkdirSync(testDir, { recursive: true })

    // Create test controller that reproduces the original issue
    fs.writeFileSync(controllerFile, `
import { Route, Get, Post, Body } from 'typoa'

interface LoginRequest {
  email: string
  password: string
}

interface LoginResponse {
  accessToken: string
  refreshToken: string
}

@Route('/jwt')
export class JwtController {
  @Post('/sign-in')
  login(@Body() req: LoginRequest): LoginResponse {
    return {
      accessToken: 'fake-access-token',
      refreshToken: 'fake-refresh-token'
    }
  }

  @Get('/health')
  health(): { status: string } {
    return { status: 'ok' }
  }

  @Post('/refresh')
  refresh(): LoginResponse {
    return {
      accessToken: 'new-access-token', 
      refreshToken: 'new-refresh-token'
    }
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

  test('Should generate correct router syntax on first run', async () => {
    await generate({
      tsconfigFilePath: tsConfigFile,
      controllers: [controllerFile],
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
        verbose: false // Reduce output noise
      }
    })

    // Verify router was generated
    assert.ok(fs.existsSync(routerFile), 'Router file should exist')

    const routerContent = fs.readFileSync(routerFile, 'utf-8')

    // Verify correct router syntax (the main bug we fixed)
    assert.ok(routerContent.includes("router.post('/jwt/sign-in'"), 'Should contain POST /jwt/sign-in')
    assert.ok(routerContent.includes("router.get('/jwt/health'"), 'Should contain GET /jwt/health')  
    assert.ok(routerContent.includes("router.post('/jwt/refresh'"), 'Should contain POST /jwt/refresh')

    // Verify controller method calls are correct
    assert.ok(routerContent.includes('controller.login.apply('), 'Should call login method')
    assert.ok(routerContent.includes('controller.health.apply('), 'Should call health method')
    assert.ok(routerContent.includes('controller.refresh.apply('), 'Should call refresh method')

    // Most importantly: verify NO malformed syntax (the bug we fixed)
    assert.ok(!routerContent.includes("router.('',"), 'Should NOT contain malformed router.() calls')
    assert.ok(!routerContent.includes('controller..apply('), 'Should NOT contain malformed controller..apply() calls')
    
    // Also check for empty string routes that would cause issues
    assert.ok(!routerContent.includes("router.post('',"), 'Should NOT have empty route paths')
    assert.ok(!routerContent.includes("router.get('',"), 'Should NOT have empty route paths')
  })

  test('Should maintain correct syntax after cache-based incremental regeneration', async () => {
    // First generation (creates cache)
    await generate({
      tsconfigFilePath: tsConfigFile,
      controllers: [controllerFile],
      root: testDir,
      openapi: { filePath: openapiFile, service: { name: 'test-service', version: '1.0.0' } },
      router: { filePath: routerFile, validateResponse: false },
      cache: { enabled: true, cacheDir: cacheDir, verbose: false }
    })

    // Verify cache was created
    assert.ok(fs.existsSync(path.join(testDir, cacheDir, 'cache.json')), 'Cache should be created')

    // Modify controller to trigger incremental regeneration
    fs.writeFileSync(controllerFile, `
import { Route, Get, Post, Delete, Body, Path } from 'typoa'

interface LoginRequest {
  email: string
  password: string
}

interface LoginResponse {
  accessToken: string
  refreshToken: string
}

@Route('/jwt')
export class JwtController {
  @Post('/sign-in')
  login(@Body() req: LoginRequest): LoginResponse {
    return {
      accessToken: 'fake-access-token',
      refreshToken: 'fake-refresh-token'
    }
  }

  @Get('/health')
  health(): { status: string } {
    return { status: 'ok' }
  }

  @Post('/refresh')
  refresh(): LoginResponse {
    return {
      accessToken: 'new-access-token', 
      refreshToken: 'new-refresh-token'
    }
  }

  // NEW METHOD - this should trigger incremental regeneration
  @Delete('/sign-out/:token')
  logout(@Path() token: string): void {
    console.log('Logging out token:', token)
  }
}
`)

    // Second generation (should use cache + incremental update)
    await generate({
      tsconfigFilePath: tsConfigFile,
      controllers: [controllerFile],
      root: testDir,
      openapi: { filePath: openapiFile, service: { name: 'test-service', version: '1.0.0' } },
      router: { filePath: routerFile, validateResponse: false },
      cache: { enabled: true, cacheDir: cacheDir, verbose: false }
    })

    const routerContent = fs.readFileSync(routerFile, 'utf-8')

    // Verify all routes including the new one
    assert.ok(routerContent.includes("router.post('/jwt/sign-in'"), 'Should contain POST /jwt/sign-in')
    assert.ok(routerContent.includes("router.get('/jwt/health'"), 'Should contain GET /jwt/health')  
    assert.ok(routerContent.includes("router.post('/jwt/refresh'"), 'Should contain POST /jwt/refresh')
    assert.ok(routerContent.includes("router.delete('/jwt/sign-out/:token'"), 'Should contain new DELETE route')

    // Verify controller method calls
    assert.ok(routerContent.includes('controller.login.apply('), 'Should call login method')
    assert.ok(routerContent.includes('controller.health.apply('), 'Should call health method')
    assert.ok(routerContent.includes('controller.refresh.apply('), 'Should call refresh method')
    assert.ok(routerContent.includes('controller.logout.apply('), 'Should call new logout method')

    // CRITICAL: verify the incremental regeneration didn't introduce the bug
    assert.ok(!routerContent.includes("router.('',"), 'Should NOT contain malformed router.() calls after incremental update')
    assert.ok(!routerContent.includes('controller..apply('), 'Should NOT contain malformed controller..apply() calls after incremental update')
    
    // Verify no empty endpoints
    assert.ok(!routerContent.includes("router.post('',"), 'Should NOT have empty route paths after incremental update')
    assert.ok(!routerContent.includes("router.delete('',"), 'Should NOT have empty route paths after incremental update')
  })

  test('Should handle multiple controllers correctly with cache', async () => {
    // Create second controller
    const userControllerFile = path.join(testDir, 'user.controller.ts')
    fs.writeFileSync(userControllerFile, `
import { Route, Get, Post, Put, Delete, Body, Path } from 'typoa'

interface User {
  id: string
  email: string
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
    return { id, email: 'test@example.com', name: 'Test User' }
  }

  @Post('/')
  create(@Body() user: Omit<User, 'id'>): User {
    return { id: '123', ...user }
  }

  @Put('/:id')
  update(@Path() id: string, @Body() user: User): User {
    return user
  }

  @Delete('/:id')
  delete(@Path() id: string): void {
    // Delete user
  }
}
`)

    // Generate with both controllers
    await generate({
      tsconfigFilePath: tsConfigFile,
      controllers: [controllerFile, userControllerFile],
      openapi: { filePath: openapiFile, service: { name: 'test-service', version: '1.0.0' } },
      router: { filePath: routerFile, validateResponse: false },
      cache: { enabled: true, cacheDir: cacheDir, verbose: false }
    })

    const routerContent = fs.readFileSync(routerFile, 'utf-8')

    // Verify JWT controller routes
    assert.ok(routerContent.includes("router.post('/jwt/sign-in'"), 'Should contain JWT routes')
    
    // Verify User controller routes  
    assert.ok(routerContent.includes("router.get('/users'"), 'Should contain GET /users')
    assert.ok(routerContent.includes("router.get('/users/:id'"), 'Should contain GET /users/:id')
    assert.ok(routerContent.includes("router.post('/users'"), 'Should contain POST /users')
    assert.ok(routerContent.includes("router.put('/users/:id'"), 'Should contain PUT /users/:id')
    assert.ok(routerContent.includes("router.delete('/users/:id'"), 'Should contain DELETE /users/:id')

    // Verify controller method calls for both controllers
    assert.ok(routerContent.includes('controller.login.apply('), 'Should call JWT controller methods')
    assert.ok(routerContent.includes('controller.list.apply('), 'Should call User controller methods')

    // Verify no malformed syntax with multiple controllers
    assert.ok(!routerContent.includes("router.('',"), 'Should NOT contain malformed router.() calls with multiple controllers')
    assert.ok(!routerContent.includes('controller..apply('), 'Should NOT contain malformed controller..apply() calls with multiple controllers')

    // Test incremental regeneration with multiple controllers
    fs.appendFileSync(userControllerFile, `\n// Added comment to trigger change\n`)

    await generate({
      tsconfigFilePath: tsConfigFile,
      controllers: [controllerFile, userControllerFile],
      openapi: { filePath: openapiFile, service: { name: 'test-service', version: '1.0.0' } },
      router: { filePath: routerFile, validateResponse: false },
      cache: { enabled: true, cacheDir: cacheDir, verbose: false }
    })

    const updatedRouterContent = fs.readFileSync(routerFile, 'utf-8')

    // All routes should still be present and correctly formatted
    assert.ok(updatedRouterContent.includes("router.post('/jwt/sign-in'"), 'JWT routes should persist after incremental update')
    assert.ok(updatedRouterContent.includes("router.get('/users'"), 'User routes should persist after incremental update')
    assert.ok(!updatedRouterContent.includes("router.('',"), 'Should NOT have malformed syntax after multi-controller incremental update')
  })
})
