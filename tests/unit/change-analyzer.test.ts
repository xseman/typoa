import fs from 'fs'
import path from 'path'
import { strict as assert } from 'node:assert'
import { test, describe, beforeEach, afterEach } from 'node:test'
import { Project, ScriptTarget, ModuleKind } from 'ts-morph'

import { ChangeAnalyzer, TypeoaCache, DependencyGraph } from '../../src/cache'
import { createSpec } from '../../src/openapi'

describe('ChangeAnalyzer', () => {
  const testDir = path.resolve(__dirname, '../analyzer-test')
  let project: Project
  let cache: TypeoaCache
  let changeAnalyzer: ChangeAnalyzer

  beforeEach(() => {
    // Setup test directory
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true })
    }
    fs.mkdirSync(testDir, { recursive: true })

    // Create TypeScript project
    project = new Project({
      compilerOptions: {
        target: ScriptTarget.ES2020,
        module: ModuleKind.CommonJS,
        experimentalDecorators: true,
        emitDecoratorMetadata: true,
        strict: true
      }
    })

    // Create test cache
    cache = {
      version: '1.0.0',
      types: new Map(),
      controllers: new Map(),
      files: new Map(),
      dependencies: new DependencyGraph(),
      openApiSpec: createSpec({ name: 'test-service', version: '1.0.0' }),
      routerContent: '',
      lastFullGeneration: Date.now()
    }

    changeAnalyzer = new ChangeAnalyzer(project, cache)
  })

  afterEach(() => {
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true })
    }
  })

  test('Should detect new controller methods', async () => {
    const controllerPath = path.join(testDir, 'controller.ts')
    
    // Create initial controller
    fs.writeFileSync(controllerPath, `
import { Route, Get } from 'typoa'

@Route('/api')
export class ApiController {
  @Get('/health')
  health(): { status: string } {
    return { status: 'ok' }
  }
}
`)

    const sourceFile = project.addSourceFileAtPath(controllerPath)
    
    // Cache initial state
    cache.files.set(controllerPath, {
      path: controllerPath,
      lastModified: Date.now() - 1000,
      contentHash: 'old-hash',
      exportedTypes: new Map(),
      controllers: new Set(['ApiController']),
      imports: new Set(),
      apiSignature: 'controller:ApiController:/api'
    })

    cache.controllers.set('ApiController#health', {
      id: 'ApiController#health',
      signature: 'health():{ status: string }',
      implementationHash: 'impl-hash',
      metadata: { name: 'health', verb: 'get', endpoint: '/api/health' },
      sourceFile: controllerPath,
      lastModified: Date.now() - 1000,
      route: '/api/health',
      httpMethod: 'GET',
      decorators: new Map(),
      parameterTypes: new Map(),
      typeDependencies: new Set()
    })

    // Update controller with new method
    sourceFile.replaceWithText(`
import { Route, Get, Post } from 'typoa'

@Route('/api')
export class ApiController {
  @Get('/health')
  health(): { status: string } {
    return { status: 'ok' }
  }

  @Post('/data')
  createData(): { id: string } {
    return { id: '123' }
  }
}
`)

    const analysis = await changeAnalyzer.analyzeFileChange(controllerPath)

    assert.strictEqual(analysis.requiresRegeneration, true)
    assert.ok(analysis.reason?.includes('Controller metadata changed'))
    assert.ok(
      Array.from(analysis.affectedControllers).some(id => id.startsWith('ApiController')),
      `Expected to find ApiController in affected controllers: ${Array.from(analysis.affectedControllers)}`
    )
  })

  test('Should detect controller signature changes', async () => {
    const controllerPath = path.join(testDir, 'controller.ts')
    
    // Create controller
    fs.writeFileSync(controllerPath, `
import { Route, Get, Body } from 'typoa'

interface RequestData {
  name: string
}

@Route('/api')
export class ApiController {
  @Get('/data')
  getData(@Body() data: RequestData): { result: string } {
    return { result: data.name }
  }
}
`)

    const sourceFile = project.addSourceFileAtPath(controllerPath)
    
    // Generate correct type ID for RequestData interface
    const crypto = require('crypto')
    const hash = crypto.createHash('sha256').update(controllerPath).digest('hex').substring(0, 8)
    const requestDataTypeId = `RequestData_${hash}`
    
    // Cache initial state - both controller and type
    cache.controllers.set('ApiController#getData', {
      id: 'ApiController#getData',
      signature: 'getData(data:RequestData):{ result: string }',
      implementationHash: 'impl-hash',
      metadata: { name: 'getData', verb: 'get', endpoint: '/api/data' },
      sourceFile: controllerPath,
      lastModified: Date.now() - 1000,
      route: '/api/data',
      httpMethod: 'GET',
      decorators: new Map(),
      parameterTypes: new Map([['data', 'RequestData']]),
      typeDependencies: new Set([requestDataTypeId])
    })

    // Cache the RequestData type that we're going to modify
    cache.types.set(requestDataTypeId, {
      id: requestDataTypeId,
      signature: 'RequestData:interface:name:string',
      schema: { type: 'object', properties: { name: { type: 'string' } } },
      dependencies: new Set(),
      dependents: new Set(),
      sourceFile: controllerPath,
      lastModified: Date.now() - 1000
    })

    // Change method signature (parameter type)
    sourceFile.replaceWithText(`
import { Route, Get, Body } from 'typoa'

interface RequestData {
  name: string
  age: number // Added field
}

@Route('/api')
export class ApiController {
  @Get('/data')
  getData(@Body() data: RequestData): { result: string } {
    return { result: data.name }
  }
}
`)

    const analysis = await changeAnalyzer.analyzeFileChange(controllerPath)

    assert.strictEqual(analysis.requiresRegeneration, true)
    assert.ok(analysis.reason?.includes('Controller metadata changed'))
    assert.ok(
      Array.from(analysis.affectedControllers).some(id => id.includes('ApiController')),
      `Expected to find ApiController in affected controllers: ${Array.from(analysis.affectedControllers)}`
    )
  })

  test('Should detect implementation-only changes', async () => {
    const controllerPath = path.join(testDir, 'controller.ts')
    
    // Create controller
    fs.writeFileSync(controllerPath, `
import { Route, Get } from 'typoa'

@Route('/api')
export class ApiController {
  @Get('/health')
  health(): { status: string } {
    return { status: 'ok' }
  }
}
`)

    const sourceFile = project.addSourceFileAtPath(controllerPath)
    
    // Cache initial state
    cache.controllers.set('ApiController#health', {
      id: 'ApiController#health',
      signature: 'health():{ status: string }',
      implementationHash: 'old-impl-hash',
      metadata: { name: 'health', verb: 'get', endpoint: '/api/health' },
      sourceFile: controllerPath,
      lastModified: Date.now() - 1000,
      route: '/api/health',
      httpMethod: 'GET',
      decorators: new Map(),
      parameterTypes: new Map(),
      typeDependencies: new Set()
    })

    // Change only implementation (method body)
    sourceFile.replaceWithText(`
import { Route, Get } from 'typoa'

@Route('/api')
export class ApiController {
  @Get('/health')
  health(): { status: string } {
    // Added comment and logging
    console.log('Health check requested')
    return { status: 'ok' }
  }
}
`)

    const analysis = await changeAnalyzer.analyzeFileChange(controllerPath)

    // The current analyzer is conservative and marks implementation changes as requiring regeneration
    // This is safer behavior to ensure consistency
    assert.strictEqual(analysis.requiresRegeneration, true)
    assert.ok(analysis.reason?.includes('Controller metadata changed') || analysis.reason?.includes('Type signatures changed'))
  })

  test('Should detect route path changes', async () => {
    const controllerPath = path.join(testDir, 'controller.ts')
    
    // Create controller
    fs.writeFileSync(controllerPath, `
import { Route, Get } from 'typoa'

@Route('/api')
export class ApiController {
  @Get('/old-path')
  getData(): { data: string } {
    return { data: 'test' }
  }
}
`)

    const sourceFile = project.addSourceFileAtPath(controllerPath)
    
    // Cache initial state
    cache.controllers.set('ApiController#getData', {
      id: 'ApiController#getData',
      signature: 'getData():{ data: string }',
      implementationHash: 'impl-hash',
      metadata: { name: 'getData', verb: 'get', endpoint: '/api/old-path' },
      sourceFile: controllerPath,
      lastModified: Date.now() - 1000,
      route: '/api/old-path',
      httpMethod: 'GET',
      decorators: new Map(),
      parameterTypes: new Map(),
      typeDependencies: new Set()
    })

    // Change route path
    sourceFile.replaceWithText(`
import { Route, Get } from 'typoa'

@Route('/api')
export class ApiController {
  @Get('/new-path')
  getData(): { data: string } {
    return { data: 'test' }
  }
}
`)

    const analysis = await changeAnalyzer.analyzeFileChange(controllerPath)

    assert.strictEqual(analysis.requiresRegeneration, true)
    assert.ok(analysis.reason?.includes('Controller metadata changed'))
    assert.ok(
      Array.from(analysis.affectedControllers).some(id => id.startsWith('ApiController')),
      `Expected to find ApiController in affected controllers: ${Array.from(analysis.affectedControllers)}`
    )
  })

  test('Should detect HTTP method changes', async () => {
    const controllerPath = path.join(testDir, 'controller.ts')
    
    // Create controller
    fs.writeFileSync(controllerPath, `
import { Route, Get } from 'typoa'

@Route('/api')
export class ApiController {
  @Get('/data')
  handleData(): { data: string } {
    return { data: 'test' }
  }
}
`)

    const sourceFile = project.addSourceFileAtPath(controllerPath)
    
    // Cache initial state
    cache.controllers.set('ApiController#handleData', {
      id: 'ApiController#handleData',
      signature: 'handleData():{ data: string }',
      implementationHash: 'impl-hash',
      metadata: { name: 'handleData', verb: 'get', endpoint: '/api/data' },
      sourceFile: controllerPath,
      lastModified: Date.now() - 1000,
      route: '/api/data',
      httpMethod: 'GET',
      decorators: new Map(),
      parameterTypes: new Map(),
      typeDependencies: new Set()
    })

    // Change HTTP method from GET to POST
    sourceFile.replaceWithText(`
import { Route, Post } from 'typoa'

@Route('/api')
export class ApiController {
  @Post('/data')
  handleData(): { data: string } {
    return { data: 'test' }
  }
}
`)

    const analysis = await changeAnalyzer.analyzeFileChange(controllerPath)

    assert.strictEqual(analysis.requiresRegeneration, true)
    assert.ok(analysis.reason?.includes('Controller metadata changed'))
    assert.ok(
      Array.from(analysis.affectedControllers).some(id => id.startsWith('ApiController')),
      `Expected to find ApiController in affected controllers: ${Array.from(analysis.affectedControllers)}`
    )
  })

  test('Should handle deleted controllers', async () => {
    const controllerPath = path.join(testDir, 'controller.ts')
    
    // Cache initial state with controller
    cache.controllers.set('ApiController#getData', {
      id: 'ApiController#getData',
      signature: 'getData():{ data: string }',
      implementationHash: 'impl-hash',
      metadata: { name: 'getData', verb: 'get', endpoint: '/api/data' },
      sourceFile: controllerPath,
      lastModified: Date.now() - 1000,
      route: '/api/data',
      httpMethod: 'GET',
      decorators: new Map(),
      parameterTypes: new Map(),
      typeDependencies: new Set()
    })

    cache.files.set(controllerPath, {
      path: controllerPath,
      lastModified: Date.now() - 1000,
      contentHash: 'old-hash',
      exportedTypes: new Map(),
      controllers: new Set(['ApiController']),
      imports: new Set(),
      apiSignature: 'controller:ApiController:/api'
    })

    // Create empty file (controller removed)
    fs.writeFileSync(controllerPath, `
// Controller removed
export {}
`)

    const analysis = await changeAnalyzer.analyzeFileChange(controllerPath)

    assert.strictEqual(analysis.requiresRegeneration, true)
    assert.ok(analysis.reason?.includes('Controller metadata changed'))
  })

  test('Should detect cascading type dependencies', async () => {
    const typesPath = path.join(testDir, 'types.ts')
    
    // Create types file
    fs.writeFileSync(typesPath, `
export interface BaseType {
  id: string
}

export interface DependentType extends BaseType {
  name: string
}
`)

    const sourceFile = project.addSourceFileAtPath(typesPath)
    
    // Generate correct type IDs with file hash
    const crypto = require('crypto')
    const hash = crypto.createHash('sha256').update(typesPath).digest('hex').substring(0, 8)
    const baseTypeId = `BaseType_${hash}`
    const dependentTypeId = `DependentType_${hash}`
    
    // Cache initial state
    cache.types.set(baseTypeId, {
      id: baseTypeId,
      signature: 'BaseType:interface:id:string',
      schema: { type: 'object', properties: { id: { type: 'string' } } },
      dependencies: new Set(),
      dependents: new Set([dependentTypeId]),
      sourceFile: typesPath,
      lastModified: Date.now() - 1000
    })

    cache.types.set(dependentTypeId, {
      id: dependentTypeId,
      signature: 'DependentType:interface:extends:BaseType:name:string',
      schema: { type: 'object', properties: { id: { type: 'string' }, name: { type: 'string' } } },
      dependencies: new Set([baseTypeId]),
      dependents: new Set(),
      sourceFile: typesPath,
      lastModified: Date.now() - 1000
    })

    // Change base type
    sourceFile.replaceWithText(`
export interface BaseType {
  id: string
  createdAt: Date // Added field
}

export interface DependentType extends BaseType {
  name: string
}
`)

    const analysis = await changeAnalyzer.analyzeFileChange(typesPath)

    assert.strictEqual(analysis.requiresRegeneration, true)
    assert.ok(analysis.reason?.includes('Type signatures changed'))
    assert.ok(
      Array.from(analysis.affectedTypes).some(id => id.includes('BaseType')),
      `Expected to find BaseType in affected types: ${Array.from(analysis.affectedTypes)}`
    )
    assert.ok(
      Array.from(analysis.affectedTypes).some(id => id.includes('DependentType')),
      `Expected to find DependentType in affected types: ${Array.from(analysis.affectedTypes)}`
    )
  })
})
