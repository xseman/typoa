import fs from 'fs'
import path from 'path'
import crypto from 'crypto'

import debug from 'debug'
import { Project, ClassDeclaration, SourceFile, Type } from 'ts-morph'
import { OpenAPIV3 } from 'openapi-types'
import handlebars from 'handlebars'
import YAML from 'yamljs'

import { createSpec } from './openapi'
import { resolve } from './resolve'
import { addController } from './controller'
import { getRelativeFilePath } from './utils'

const log = debug('typoa:cache')

/**
 * Basic cache data structure
 */
export interface CacheData {
  version: string
  entries: Record<string, CacheEntry>
  lastModified: number
  openApiSpec?: OpenAPIV3.Document
  routerContent?: string
}

/**
 * Simplified cache entry
 */
export interface CacheEntry {
  id: string
  type: 'controller' | 'type' | 'file'
  signature: string
  lastModified: number
  dependencies: string[]
  content?: string
}

/**
 * File state for change detection
 */
export interface FileState {
  exists: boolean
  size: number
  mtime: number
  checksum: string
}

/**
 * Change summary from detection
 */
export interface ChangeSummary {
  changedFiles: string[]
  newFiles: string[]
  deletedFiles: string[]
}

/**
 * Simple cache configuration
 */
export interface CacheConfig {
  enabled: boolean
  directory: string
  maxSize?: number
}

export interface TypeCacheEntry {
  id: string
  signature: string
  schema: any
  sourceFile: string
  lastModified: number
  dependencies: Set<string>
  dependents: Set<string>
}

export interface ControllerCacheEntry {
  id: string
  signature: string
  implementationHash: string
  metadata: any
  sourceFile: string
  lastModified: number
  route: string
  httpMethod: string
  decorators: Map<string, any>
  parameterTypes: Map<string, string>
  typeDependencies: Set<string>
}

export interface FileCacheEntry {
  path: string
  contentHash: string
  lastModified: number
  exportedTypes: Map<string, string>
  controllers: Set<string>
  imports: Set<string>
  apiSignature: string
}

export interface TypeoaCache {
  version: string
  types: Map<string, TypeCacheEntry>
  controllers: Map<string, ControllerCacheEntry>
  files: Map<string, FileCacheEntry>
  dependencies: DependencyGraph
  openApiSpec: any
  routerContent: string
  lastFullGeneration: number
}

export interface ChangeAnalysis {
  requiresRegeneration: boolean
  reason?: string
  affectedTypes: Set<string>
  affectedControllers: Set<string>
  changes: {
    typeSignatureChanges: Map<string, TypeChange>
    controllerMetadataChanges: Map<string, ControllerChange>
    implementationOnlyChanges: Set<string>
  }
}

export interface TypeChange {
  typeId: string
  oldSignature: string
  newSignature: string
  type: 'signature' | 'dependencies' | 'removed'
}

export interface ControllerChange {
  controllerId: string
  type: 'method' | 'route' | 'implementation'
  method?: string
  oldValue?: any
  newValue?: any
}

export interface RegenerationResult {
  regeneratedTypes: Set<string>
  regeneratedControllers: Set<string>
  regeneratedPaths: Set<string>
  skippedImplementationChanges: Set<string>
  timeTaken: number
}

export interface CacheStats {
  size: number
  lastModified: Date
  version: string
  typeCount: number
  controllerCount: number
  fileCount: number
}

export interface ValidationResult {
  isValid: boolean
  errors: string[]
  warnings: string[]
}

export class DependencyGraph {
  private dependencies: Map<string, Set<string>> = new Map()
  private dependents: Map<string, Set<string>> = new Map()

  addDependency(dependent: string, dependency: string): void {
    if (!this.dependencies.has(dependent)) {
      this.dependencies.set(dependent, new Set())
    }
    if (!this.dependents.has(dependency)) {
      this.dependents.set(dependency, new Set())
    }
    
    this.dependencies.get(dependent)!.add(dependency)
    this.dependents.get(dependency)!.add(dependent)
  }

  removeDependencies(typeId: string): void {
    // Remove as dependent
    const deps = this.dependencies.get(typeId)
    if (deps) {
      for (const dep of deps) {
        const dependents = this.dependents.get(dep)
        if (dependents) {
          dependents.delete(typeId)
        }
      }
      this.dependencies.delete(typeId)
    }
    
    // Remove as dependency
    const dependents = this.dependents.get(typeId)
    if (dependents) {
      for (const dependent of dependents) {
        const deps = this.dependencies.get(dependent)
        if (deps) {
          deps.delete(typeId)
        }
      }
      this.dependents.delete(typeId)
    }
  }

  getAffectedTypes(changedTypes: Set<string>): Set<string> {
    const affected = new Set<string>()
    const queue = Array.from(changedTypes)
    
    for (const typeId of queue) {
      affected.add(typeId)
    }
    
    while (queue.length > 0) {
      const current = queue.shift()!
      const dependents = this.dependents.get(current)
      
      if (dependents) {
        for (const dependent of dependents) {
          if (!affected.has(dependent)) {
            affected.add(dependent)
            queue.push(dependent)
          }
        }
      }
    }
    
    return affected
  }

  getTopologicalOrder(): string[] {
    const visited = new Set<string>()
    const temp = new Set<string>()
    const result: string[] = []
    
    const visit = (typeId: string) => {
      if (temp.has(typeId)) {
        throw new Error(`Circular dependency detected involving ${typeId}`)
      }
      if (visited.has(typeId)) return
      
      temp.add(typeId)
      const deps = this.dependencies.get(typeId)
      if (deps) {
        for (const dep of deps) {
          visit(dep)
        }
      }
      temp.delete(typeId)
      visited.add(typeId)
      result.push(typeId)
    }
    
    // Visit all types
    const allTypes = new Set([
      ...this.dependencies.keys(),
      ...this.dependents.keys()
    ])
    
    for (const typeId of allTypes) {
      if (!visited.has(typeId)) {
        visit(typeId)
      }
    }
    
    return result
  }

  toJSON(): { dependencies: [string, string[]][]; dependents: [string, string[]][] } {
    return {
      dependencies: Array.from(this.dependencies.entries()).map(([key, deps]) => [
        key,
        Array.from(deps)
      ]),
      dependents: Array.from(this.dependents.entries()).map(([key, deps]) => [
        key,
        Array.from(deps)
      ])
    }
  }

  static fromJSON(data: { dependencies: [string, string[]][]; dependents: [string, string[]][] }): DependencyGraph {
    const graph = new DependencyGraph()
    
    for (const [dependent, deps] of data.dependencies) {
      graph.dependencies.set(dependent, new Set(deps))
    }
    
    for (const [dependency, deps] of data.dependents) {
      graph.dependents.set(dependency, new Set(deps))
    }
    
    return graph
  }
}

class TypeSignatureComputer {
  computeTypeSignature(type: Type): string {
    const symbol = type.getSymbol()
    const typeText = type.getText()
    
    if (symbol) {
      const declarations = symbol.getValueDeclaration() || symbol.getDeclarations()[0]
      if (declarations) {
        return `${typeText}:${declarations.getSourceFile().getFilePath()}`
      }
    }
    
    return typeText
  }
}

const typeSignatureComputer = new TypeSignatureComputer()

export class CacheManager {
  private cacheDir: string
  private cacheFile: string
  private lockFile: string
  
  constructor(cacheDir: string = '.typoa-cache', root: string = process.cwd()) {
    this.cacheDir = path.join(root, cacheDir)
    this.cacheFile = path.join(root, cacheDir, 'cache.json')
    this.lockFile = path.join(root, cacheDir, 'cache.lock')
  }
  
  async load(): Promise<TypeoaCache | null> {
    try {
      if (!fs.existsSync(this.cacheFile)) {
        log('Cache file does not exist')
        return null
      }
      
      const rawData = fs.readFileSync(this.cacheFile, 'utf-8')
      const data = JSON.parse(rawData)
      
      if (!data.version || !this.isVersionCompatible(data.version)) {
        log('Cache version incompatible, invalidating')
        return null
      }
      
      const cache: TypeoaCache = {
        version: data.version,
        types: this.reconstructMap(data.types, (entry) => ({
          ...entry,
          dependencies: new Set(entry.dependencies),
          dependents: new Set(entry.dependents)
        })),
        controllers: this.reconstructMap(data.controllers, (entry) => ({
          ...entry,
          parameterTypes: new Map(entry.parameterTypes),
          typeDependencies: new Set(entry.typeDependencies),
          decorators: new Map(entry.decorators)
        })),
        files: this.reconstructMap(data.files, (entry) => ({
          ...entry,
          exportedTypes: new Map(entry.exportedTypes),
          controllers: new Set(entry.controllers),
          imports: new Set(entry.imports)
        })),
        dependencies: DependencyGraph.fromJSON(data.dependencies),
        openApiSpec: data.openApiSpec,
        routerContent: data.routerContent || '',
        lastFullGeneration: data.lastFullGeneration || Date.now()
      }
      
      return cache
    } catch (error) {
      log('Failed to load cache, will regenerate:', error)
      return null
    }
  }
  
  async save(cache: TypeoaCache): Promise<void> {
    try {
      await fs.promises.mkdir(this.cacheDir, { recursive: true })
      await this.acquireLock()
      
      try {
        const serializedData = {
          version: cache.version,
          types: this.serializeMap(cache.types, (entry) => ({
            ...entry,
            dependencies: Array.from(entry.dependencies),
            dependents: Array.from(entry.dependents)
          })),
          controllers: this.serializeMap(cache.controllers, (entry) => ({
            ...entry,
            parameterTypes: Array.from(entry.parameterTypes.entries()),
            typeDependencies: Array.from(entry.typeDependencies),
            decorators: Array.from(entry.decorators.entries())
          })),
          files: this.serializeMap(cache.files, (entry) => ({
            ...entry,
            exportedTypes: Array.from(entry.exportedTypes.entries()),
            controllers: Array.from(entry.controllers),
            imports: Array.from(entry.imports)
          })),
          dependencies: cache.dependencies.toJSON(),
          openApiSpec: cache.openApiSpec,
          routerContent: cache.routerContent,
          lastFullGeneration: cache.lastFullGeneration
        }
        
        // Atomic write
        const tempFile = `${this.cacheFile}.tmp`
        await fs.promises.writeFile(tempFile, JSON.stringify(serializedData, null, 2))
        await fs.promises.rename(tempFile, this.cacheFile)
        
        log('Cache saved successfully')
      } finally {
        await this.releaseLock()
      }
    } catch (error) {
      log('Failed to save cache:', error)
    }
  }
  
  async clear(): Promise<void> {
    try {
      if (fs.existsSync(this.cacheDir)) {
        await fs.promises.rm(this.cacheDir, { recursive: true })
      }
    } catch (error) {
      log('Failed to clear cache:', error)
    }
  }
  
  async exists(): Promise<boolean> {
    try {
      const stats = await fs.promises.stat(this.cacheFile)
      return stats.isFile()
    } catch {
      return false
    }
  }
  
  async getStats(): Promise<CacheStats | null> {
    try {
      if (!await this.exists()) {
        return null
      }
      
      const stats = await fs.promises.stat(this.cacheFile)
      const content = await fs.promises.readFile(this.cacheFile, 'utf-8')
      const data = JSON.parse(content)
      
      return {
        size: stats.size,
        lastModified: stats.mtime,
        version: data.version,
        typeCount: data.types?.length || 0,
        controllerCount: data.controllers?.length || 0,
        fileCount: data.files?.length || 0
      }
    } catch (error) {
      log('Failed to get cache stats:', error)
      return null
    }
  }
  
  initializeCache(serviceName: string, serviceVersion: string): TypeoaCache {
    return {
      version: '1.0.0',
      types: new Map(),
      controllers: new Map(),
      dependencies: new DependencyGraph(),
      files: new Map(),
      openApiSpec: createSpec({ name: serviceName, version: serviceVersion }),
      routerContent: '',
      lastFullGeneration: Date.now()
    }
  }
  
  async validateCache(cache: TypeoaCache): Promise<ValidationResult> {
    const result: ValidationResult = {
      isValid: true,
      errors: [],
      warnings: []
    }
    
    try {
      if (!cache.version || !cache.openApiSpec) {
        result.isValid = false
        result.errors.push('Missing required cache fields')
        return result
      }
      
      for (const [typeId, typeEntry] of cache.types) {
        if (!typeEntry.sourceFile || !fs.existsSync(typeEntry.sourceFile)) {
          result.warnings.push(`Type ${typeId} source file not found: ${typeEntry.sourceFile}`)
        }
      }
      
      for (const [controllerId, controller] of cache.controllers) {
        if (!controller.sourceFile || !fs.existsSync(controller.sourceFile)) {
          result.warnings.push(`Controller ${controllerId} source file not found: ${controller.sourceFile}`)
        }
      }
      
      for (const [filePath] of cache.files) {
        if (!fs.existsSync(filePath)) {
          result.warnings.push(`File not found: ${filePath}`)
        }
      }
      
    } catch (error) {
      result.isValid = false
      result.errors.push(`Validation error: ${error}`)
    }
    
    return result
  }
  
  private isVersionCompatible(version: string): boolean {
    const [major] = version.split('.').map(Number)
    const [currentMajor] = '1.0.0'.split('.').map(Number)
    return major === currentMajor
  }
  
  private serializeMap<T, U>(map: Map<string, T>, transformer?: (value: T) => U): [string, U | T][] {
    return Array.from(map.entries()).map(([key, value]) => [
      key,
      transformer ? transformer(value) : value
    ])
  }
  
  private reconstructMap<T, U>(data: [string, T][], transformer?: (value: T) => U): Map<string, U | T> {
    return new Map(data.map(([key, value]) => [
      key,
      transformer ? transformer(value) : value
    ]))
  }
  
  private async acquireLock(timeout: number = 5000): Promise<void> {
    const startTime = Date.now()
    
    while (Date.now() - startTime < timeout) {
      try {
        await fs.promises.writeFile(this.lockFile, process.pid.toString(), { flag: 'wx' })
        return
      } catch (error: any) {
        if (error.code !== 'EEXIST') {
          throw error
        }
        
        try {
          const lockPid = await fs.promises.readFile(this.lockFile, 'utf-8')
          const pidExists = process.kill(parseInt(lockPid), 0)
          if (!pidExists) {
            await fs.promises.unlink(this.lockFile)
          }
        } catch {
          // Lock file is stale, try to remove it
          try {
            await fs.promises.unlink(this.lockFile)
          } catch {}
        }
        
        await new Promise(resolve => setTimeout(resolve, 100))
      }
    }
    
    throw new Error('Failed to acquire cache lock within timeout')
  }
  
  private async releaseLock(): Promise<void> {
    try {
      await fs.promises.unlink(this.lockFile)
    } catch (error) {
      log('Failed to release lock:', error)
    }
  }
}

export class ChangeAnalyzer {
  private project: Project
  private cache: TypeoaCache
  
  constructor(project: Project, cache: TypeoaCache) {
    this.project = project
    this.cache = cache
  }
  
  async analyzeFileChange(filePath: string, newContent?: string): Promise<ChangeAnalysis> {
    const analysis: ChangeAnalysis = {
      requiresRegeneration: false,
      affectedTypes: new Set(),
      affectedControllers: new Set(),
      changes: {
        typeSignatureChanges: new Map(),
        controllerMetadataChanges: new Map(),
        implementationOnlyChanges: new Set()
      }
    }
    
    if (!newContent) {
      try {
        newContent = await fs.promises.readFile(filePath, 'utf-8')
      } catch (error) {
        return this.analyzeFileRemoval(filePath)
      }
    }
    
    const newContentHash = this.computeHash(newContent)
    const cachedFile = this.cache.files.get(filePath)
    
    if (cachedFile && cachedFile.contentHash === newContentHash) {
      return analysis
    }
    
    let sourceFile: SourceFile
    try {
      sourceFile = this.project.createSourceFile(filePath, newContent, { overwrite: true })
    } catch (error) {
      log(`Failed to parse ${filePath}:`, error)
      analysis.requiresRegeneration = true
      analysis.reason = 'Failed to parse file - assuming changes needed'
      return analysis
    }
    
    try {
      return await this.performSafeAnalysis(sourceFile, cachedFile, analysis)
    } catch (error) {
      log(`Detailed analysis failed for ${filePath}, trying basic comparison:`, (error as Error).message)
      return this.performBasicStructuralAnalysis(sourceFile, cachedFile, analysis)
    }
  }
  
  private async performSafeAnalysis(
    sourceFile: SourceFile, 
    cachedFile: FileCacheEntry | undefined, 
    analysis: ChangeAnalysis
  ): Promise<ChangeAnalysis> {
    const typeChanges = await this.analyzeTypeChanges(sourceFile, cachedFile)
    if (typeChanges.hasSignatureChanges) {
      analysis.requiresRegeneration = true
      analysis.reason = 'Type signatures changed'
      
      for (const [typeId, change] of typeChanges.changes) {
        analysis.affectedTypes.add(typeId)
        analysis.changes.typeSignatureChanges.set(typeId, change)
      }
    }
    
    const controllerChanges = await this.analyzeControllerChanges(sourceFile, cachedFile)
    if (controllerChanges.hasMetadataChanges) {
      analysis.requiresRegeneration = true
      analysis.reason = analysis.reason 
        ? `${analysis.reason}; Controller metadata changed`
        : 'Controller metadata changed'
      
      for (const [controllerId, change] of controllerChanges.changes) {
        analysis.affectedControllers.add(controllerId)
        analysis.changes.controllerMetadataChanges.set(controllerId, change)
      }
    }
    
    if (controllerChanges.hasImplementationChanges) {
      for (const [controllerId] of controllerChanges.changes) {
        analysis.changes.implementationOnlyChanges.add(controllerId)
      }
    }
    
    return analysis
  }
  
  private performBasicStructuralAnalysis(
    sourceFile: SourceFile,
    cachedFile: FileCacheEntry | undefined,
    analysis: ChangeAnalysis
  ): ChangeAnalysis {
    analysis.requiresRegeneration = true
    analysis.reason = 'File structure changed - performing conservative regeneration'
    
    const classes = sourceFile.getClasses()
    for (const classDecl of classes) {
      const routeDecorator = classDecl.getDecorator('Route')
      if (routeDecorator) {
        analysis.affectedControllers.add(classDecl.getName()!)
      }
    }
    
    return analysis
  }
  
  private async analyzeTypeChanges(
    sourceFile: SourceFile,
    cachedFile?: FileCacheEntry
  ): Promise<{ hasSignatureChanges: boolean; changes: Map<string, TypeChange> }> {
    const changes = new Map<string, TypeChange>()
    let hasSignatureChanges = false
    
    const declarations = sourceFile.getExportedDeclarations()
    
    for (const [name, decls] of declarations) {
      const decl = decls[0]
      if (!decl) continue
      
      const typeId = this.generateTypeId(name, sourceFile.getFilePath())
      const cachedType = this.cache.types.get(typeId)
      
      if (cachedType) {
        const type = decl.getType()
        const newSignature = typeSignatureComputer.computeTypeSignature(type)
        
        if (cachedType.signature !== newSignature) {
          hasSignatureChanges = true
          changes.set(typeId, {
            typeId,
            oldSignature: cachedType.signature,
            newSignature,
            type: 'signature'
          })
        }
      }
    }
    
    return { hasSignatureChanges, changes }
  }
  
  private async analyzeControllerChanges(
    sourceFile: SourceFile,
    cachedFile?: FileCacheEntry
  ): Promise<{ 
    hasMetadataChanges: boolean; 
    hasImplementationChanges: boolean; 
    changes: Map<string, ControllerChange> 
  }> {
    const changes = new Map<string, ControllerChange>()
    let hasMetadataChanges = false
    let hasImplementationChanges = false
    
    const classes = sourceFile.getClasses()
    
    for (const classDecl of classes) {
      const routeDecorator = classDecl.getDecorator('Route')
      if (!routeDecorator) continue
      
      const controllerName = classDecl.getName()!
      const controllerChanges = this.analyzeControllerClass(classDecl, controllerName, cachedFile)
      
      for (const change of controllerChanges) {
        changes.set(change.controllerId, change)
        if (change.type === 'implementation') {
          hasImplementationChanges = true
        } else {
          hasMetadataChanges = true
        }
      }
    }
    
    if (cachedFile) {
      const currentControllers = new Set(
        classes
          .filter(c => c.getDecorator('Route'))
          .map(c => c.getName()!)
      )
      
      for (const controllerId of cachedFile.controllers) {
        const [controllerName] = controllerId.split('#')
        if (!currentControllers.has(controllerName)) {
          hasMetadataChanges = true
          changes.set(controllerId, {
            controllerId,
            type: 'method',
            oldValue: 'exists',
            newValue: 'deleted'
          })
        }
      }
    }
    
    return { hasMetadataChanges, hasImplementationChanges, changes }
  }
  
  private analyzeControllerClass(
    classDecl: ClassDeclaration,
    controllerName: string,
    cachedFile?: FileCacheEntry
  ): ControllerChange[] {
    const changes: ControllerChange[] = []
    
    const routeDecorator = classDecl.getDecorator('Route')!
    const newRoute = this.extractDecoratorArgument(routeDecorator, 0) || ''
    
    const cachedControllers = Array.from(this.cache.controllers.entries())
      .filter(([id]) => id.startsWith(`${controllerName}#`))
    
    if (cachedControllers.length > 0) {
      const cachedRoute = cachedControllers[0][1].route
      if (cachedRoute !== newRoute) {
        changes.push({
          controllerId: `${controllerName}#route`,
          type: 'route',
          oldValue: cachedRoute,
          newValue: newRoute
        })
      }
    }
    
    const methods = classDecl.getMethods()
    
    for (const method of methods) {
      const methodChanges = this.analyzeControllerMethod(method, controllerName)
      changes.push(...methodChanges)
    }
    
    return changes
  }
  
  private analyzeControllerMethod(
    method: any,
    controllerName: string
  ): ControllerChange[] {
    const changes: ControllerChange[] = []
    const methodName = method.getName()
    const controllerId = `${controllerName}#${methodName}`
    
    const httpDecorators = ['Get', 'Post', 'Put', 'Delete', 'Patch', 'Head', 'Options']
    const httpDecorator = httpDecorators
      .map(name => method.getDecorator(name))
      .find(d => d !== undefined)
    
    if (!httpDecorator) {
      if (this.cache.controllers.has(controllerId)) {
        changes.push({
          controllerId,
          type: 'method',
          method: methodName,
          oldValue: 'exists',
          newValue: 'deleted'
        })
      }
      return changes
    }
    
    const cachedController = this.cache.controllers.get(controllerId)
    
    const newHttpMethod = httpDecorator.getName()
    if (cachedController && cachedController.httpMethod !== newHttpMethod) {
      changes.push({
        controllerId,
        type: 'method',
        method: methodName,
        oldValue: cachedController.httpMethod,
        newValue: newHttpMethod
      })
    }
    
    const newRoute = this.extractDecoratorArgument(httpDecorator, 0) || ''
    if (cachedController && cachedController.route !== newRoute) {
      changes.push({
        controllerId,
        type: 'route',
        method: methodName,
        oldValue: cachedController.route,
        newValue: newRoute
      })
    }
    
    return changes
  }
  
  private analyzeFileRemoval(filePath: string): ChangeAnalysis {
    const analysis: ChangeAnalysis = {
      requiresRegeneration: true,
      reason: 'File was deleted',
      affectedTypes: new Set(),
      affectedControllers: new Set(),
      changes: {
        typeSignatureChanges: new Map(),
        controllerMetadataChanges: new Map(),
        implementationOnlyChanges: new Set()
      }
    }
    
    const cachedFile = this.cache.files.get(filePath)
    if (cachedFile) {
      for (const typeId of cachedFile.exportedTypes.values()) {
        analysis.affectedTypes.add(typeId)
      }
      
      for (const controllerId of cachedFile.controllers) {
        analysis.affectedControllers.add(controllerId)
      }
    }
    
    return analysis
  }
  
  private computeHash(content: string): string {
    return crypto.createHash('sha256').update(content).digest('hex')
  }
  
  private extractDecoratorArgument(decorator: any, index: number): string | undefined {
    const args = decorator.getArguments()
    if (args.length > index) {
      const arg = args[index].getText()
      return arg.replace(/['"]/g, '')
    }
    return undefined
  }
  
  private generateTypeId(typeName: string, filePath: string): string {
    const hash = crypto.createHash('sha256').update(filePath).digest('hex').substring(0, 8)
    return `${typeName}_${hash}`
  }
}

export class RegenerationManager {
  private cache: TypeoaCache
  private project: Project
  private config: any
  
  constructor(cache: TypeoaCache, project: Project, config: any) {
    this.cache = cache
    this.project = project
    this.config = config
  }
  
  async processChanges(analysis: ChangeAnalysis): Promise<RegenerationResult> {
    const startTime = Date.now()
    
    const result: RegenerationResult = {
      regeneratedTypes: new Set(),
      regeneratedControllers: new Set(),
      regeneratedPaths: new Set(),
      skippedImplementationChanges: analysis.changes.implementationOnlyChanges,
      timeTaken: 0
    }
    
    if (!analysis.requiresRegeneration) {
      log('No changes detected, using cached output')
      result.timeTaken = Date.now() - startTime
      return result
    }
    
    log(`Processing changes: ${analysis.reason}`)
    
    try {
      if (analysis.changes.typeSignatureChanges.size > 0) {
        await this.handleTypeChanges(
          new Set(analysis.changes.typeSignatureChanges.keys()),
          result
        )
      }
      
      if (analysis.changes.controllerMetadataChanges.size > 0) {
        await this.handleControllerChanges(
          new Set(analysis.changes.controllerMetadataChanges.keys()),
          result
        )
      }
      
      const typeAffectedControllers = this.findControllersAffectedByTypes(result.regeneratedTypes)
      for (const controllerId of typeAffectedControllers) {
        result.regeneratedControllers.add(controllerId)
      }
      
      if (result.regeneratedControllers.size > 0) {
        await this.updateOpenApiSpec(result)
      }
      
      if (result.regeneratedControllers.size > 0) {
        await this.regenerateRouter()
      }
      
      await this.writeOutputFiles()
      
    } catch (error) {
      log('Error during incremental regeneration:', error)
      throw error
    }
    
    result.timeTaken = Date.now() - startTime
    
    log(`Incremental regeneration completed in ${result.timeTaken}ms`)
    log(`  - Types: ${result.regeneratedTypes.size}`)
    log(`  - Controllers: ${result.regeneratedControllers.size}`)
    log(`  - Paths: ${result.regeneratedPaths.size}`)
    
    return result
  }
  
  private async handleTypeChanges(
    directlyAffectedTypes: Set<string>,
    result: RegenerationResult
  ): Promise<void> {
    const allAffectedTypes = this.cache.dependencies.getAffectedTypes(directlyAffectedTypes)
    
    log(`Regenerating ${allAffectedTypes.size} types (${directlyAffectedTypes.size} direct, ${allAffectedTypes.size - directlyAffectedTypes.size} cascading)`)
    
    const typeOrder = this.cache.dependencies.getTopologicalOrder()
    const orderedAffectedTypes = typeOrder.filter(typeId => allAffectedTypes.has(typeId))
    
    for (const typeId of orderedAffectedTypes) {
      await this.regenerateType(typeId)
      result.regeneratedTypes.add(typeId)
    }
  }
  
  private async handleControllerChanges(
    affectedControllers: Set<string>,
    result: RegenerationResult
  ): Promise<void> {
    log(`Regenerating ${affectedControllers.size} controller methods`)
    
    for (const controllerId of affectedControllers) {
      await this.regenerateController(controllerId)
      result.regeneratedControllers.add(controllerId)
      
      const controller = this.cache.controllers.get(controllerId)
      if (controller) {
        result.regeneratedPaths.add(controller.route)
      }
    }
  }
  
  private findControllersAffectedByTypes(regeneratedTypes: Set<string>): Set<string> {
    const affectedControllers = new Set<string>()
    
    for (const [controllerId, controller] of this.cache.controllers) {
      const usesRegeneratedType = Array.from(controller.typeDependencies)
        .some(typeId => regeneratedTypes.has(typeId))
      
      if (usesRegeneratedType) {
        affectedControllers.add(controllerId)
      }
    }
    
    return affectedControllers
  }
  
  private async regenerateType(typeId: string): Promise<void> {
    const cachedType = this.cache.types.get(typeId)
    if (!cachedType) return
    
    const sourceFile = this.project.getSourceFile(cachedType.sourceFile)
    if (!sourceFile) return
    
    const declarations = sourceFile.getExportedDeclarations()
    let declaration: any = null
    
    for (const [name, decls] of declarations) {
      const decl = decls[0]
      if (decl && this.generateTypeId(name, cachedType.sourceFile) === typeId) {
        declaration = decl
        break
      }
    }
    
    if (!declaration) return
    
    const type = declaration.getType()
    
    this.cache.dependencies.removeDependencies(typeId)
    
    const resolved = resolve(type, this.cache.openApiSpec)
    
    cachedType.schema = resolved
    cachedType.signature = typeSignatureComputer.computeTypeSignature(type)
    cachedType.lastModified = Date.now()
    
    if (!('$ref' in resolved)) {
      this.cache.openApiSpec.components!.schemas![typeId] = resolved
    }
  }
  
  private async regenerateController(controllerId: string): Promise<void> {
    const cachedController = this.cache.controllers.get(controllerId)
    if (!cachedController) return
    
    const sourceFile = this.project.getSourceFile(cachedController.sourceFile)
    if (!sourceFile) return
    
    const [controllerName, methodName] = controllerId.split('#')
    const controller = sourceFile.getClass(controllerName)
    if (!controller) return
    
    const tempCodegen: any = {}
    addController(controller, this.cache.openApiSpec, tempCodegen, this.config.router)
    
    const methods = tempCodegen[controllerName] || []
    const method = methods.find((m: any) => m.name === methodName)
    
    if (method) {
      cachedController.metadata = method
      cachedController.lastModified = Date.now()
      cachedController.typeDependencies = this.extractTypeDependencies(method)
      cachedController.parameterTypes = this.extractParameterTypes(method)
      cachedController.decorators = this.extractDecorators(controller, controllerName, methodName)
    }
  }
  
  private async updateOpenApiSpec(result: RegenerationResult): Promise<void> {
    const affectedFiles = new Set<string>()
    
    for (const controllerId of result.regeneratedControllers) {
      const controller = this.cache.controllers.get(controllerId)
      if (controller) {
        affectedFiles.add(controller.sourceFile)
      }
    }
    
    for (const filePath of affectedFiles) {
      const sourceFile = this.project.getSourceFile(filePath)
      if (sourceFile) {
        const classes = sourceFile.getClasses()
        for (const classDecl of classes) {
          if (classDecl.getDecorator('Route')) {
            const tempCodegen: any = {}
            addController(classDecl, this.cache.openApiSpec, tempCodegen, this.config.router)
          }
        }
      }
    }
  }
  
  private async regenerateRouter(): Promise<void> {
    const codegenControllers: any = {}
    const controllersPathByName: Record<string, string> = {}
    
    const fileControllers = new Map<string, Set<string>>()
    for (const [controllerId, controller] of this.cache.controllers) {
      const [controllerName] = controllerId.split('#')
      if (!fileControllers.has(controller.sourceFile)) {
        fileControllers.set(controller.sourceFile, new Set())
      }
      fileControllers.get(controller.sourceFile)!.add(controllerName)
    }
    
    for (const [filePath, controllerNames] of fileControllers) {
      const sourceFile = this.project.getSourceFile(filePath)
      if (sourceFile) {
        for (const controllerName of controllerNames) {
          const controller = sourceFile.getClass(controllerName)
          if (controller && controller.getDecorator('Route')) {
            controllersPathByName[controllerName] = filePath
            addController(controller, this.cache.openApiSpec, codegenControllers, this.config.router)
          }
        }
      }
    }
    
    // Try multiple template locations for robustness
    let templateFilePath: string
    if (this.config.router.templateFilePath) {
      templateFilePath = path.resolve(this.config.root || process.cwd(), this.config.router.templateFilePath)
    } else {
      const possiblePaths = [
        path.join(__dirname, 'template', 'express.ts.hbs'),
        path.join(__dirname, '..', 'template', 'express.ts.hbs'),
        path.join(process.cwd(), 'node_modules', 'typoa', 'template', 'express.ts.hbs')
      ]
      
      templateFilePath = possiblePaths.find(p => fs.existsSync(p)) || possiblePaths[0]
    }
    
    handlebars.registerHelper('json', (context: any) => {
      return JSON.stringify(context)
    })
    
    const templateContent = await fs.promises.readFile(templateFilePath, 'utf-8')
    const compiledTemplate = handlebars.compile(templateContent.toString(), { noEscape: true })
    
    const routerFilePath = path.resolve(this.config.root || process.cwd(), this.config.router.filePath)
    
    this.cache.routerContent = compiledTemplate({
      securityMiddleware: this.config.router.securityMiddlewarePath ? getRelativeFilePath(
        path.dirname(routerFilePath),
        path.resolve(this.config.root || process.cwd(), this.config.router.securityMiddlewarePath)
      ) : undefined,
      validateResponse: this.config.router.validateResponse,
      runtimeImport: this.config.router.runtimeImport || process.env.TYPOA_RUNTIME_IMPORT || 'typoa',
      controllers: Object.keys(codegenControllers).map((controllerName) => ({
        name: controllerName,
        path: getRelativeFilePath(path.dirname(routerFilePath), controllersPathByName[controllerName]),
        methods: codegenControllers[controllerName].map((method: any) => ({
          ...method,
          middlewares: method.middlewares || []
        }))
      })),
      schemas: this.cache.openApiSpec.components!.schemas,
      middlewares: Object
        .values(codegenControllers)
        .flatMap((controller: any) => controller.flatMap((method: any) => method.middlewares || []))
        .filter((middleware: any, index: number, self: any[]) => 
          self.findIndex((m: any) => m.name === middleware.name) === index
        )
    })
  }
  
  private async writeOutputFiles(): Promise<void> {
    const root = this.config.root || process.cwd()
    
    const filePaths = Array.isArray(this.config.openapi.filePath)
      ? this.config.openapi.filePath
      : [this.config.openapi.filePath]
    
    for (const filePath of filePaths) {
      const resolvedPath = path.resolve(root, filePath)
      const content = filePath.endsWith('.yaml') || filePath.endsWith('.yml')
        ? YAML.stringify(this.cache.openApiSpec, 2)
        : JSON.stringify(this.cache.openApiSpec, null, 2)
      
      await fs.promises.writeFile(resolvedPath, content)
    }
    
    const routerFilePath = path.resolve(root, this.config.router.filePath)
    await fs.promises.writeFile(routerFilePath, this.cache.routerContent)
  }
  
  private extractTypeDependencies(methodMetadata: any): Set<string> {
    const dependencies = new Set<string>()
    
    if (methodMetadata.params) {
      for (const param of methodMetadata.params) {
        if (param.schema?.$ref) {
          dependencies.add(param.schema.$ref.replace('#/components/schemas/', ''))
        }
      }
    }
    
    if (methodMetadata.body?.content) {
      for (const mediaType of Object.values(methodMetadata.body.content)) {
        const schema = (mediaType as any).schema
        if (schema?.$ref) {
          dependencies.add(schema.$ref.replace('#/components/schemas/', ''))
        }
      }
    }
    
    if (methodMetadata.responses) {
      for (const response of Object.values(methodMetadata.responses)) {
        const content = (response as any).content
        if (content) {
          for (const mediaType of Object.values(content)) {
            const schema = (mediaType as any).schema
            if (schema?.$ref) {
              dependencies.add(schema.$ref.replace('#/components/schemas/', ''))
            }
          }
        }
      }
    }
    
    return dependencies
  }
  
  private extractParameterTypes(methodMetadata: any): Map<string, string> {
    const paramTypes = new Map<string, string>()
    
    if (methodMetadata.params) {
      for (const param of methodMetadata.params) {
        paramTypes.set(param.name, param.schema?.type || 'unknown')
      }
    }
    
    return paramTypes
  }
  
  private extractDecorators(controller: ClassDeclaration, controllerName: string, methodName: string): Map<string, any> {
    const decorators = new Map<string, any>()
    
    const controllerDecorators = controller.getDecorators()
    for (const decorator of controllerDecorators) {
      decorators.set(`controller:${decorator.getName()}`, decorator.getArguments().map(arg => arg.getText()))
    }
    
    const method = controller.getMethod(methodName)
    if (method) {
      const methodDecorators = method.getDecorators()
      for (const decorator of methodDecorators) {
        decorators.set(`method:${decorator.getName()}`, decorator.getArguments().map(arg => arg.getText()))
      }
    }
    
    return decorators
  }
  
  private generateTypeId(typeName: string, filePath: string): string {
    const hash = crypto.createHash('sha256').update(filePath).digest('hex').substring(0, 8)
    return `${typeName}_${hash}`
  }
}
