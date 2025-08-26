import { getCompilerOptionsFromTsConfig, Project, TypeAliasDeclaration, ClassDeclaration, InterfaceDeclaration, ExportedDeclarations } from 'ts-morph'
import glob from 'glob'
import { promisify } from 'util'
import path from 'path'
import { OpenAPIV3 } from 'openapi-types'
import YAML from 'yamljs'
import fs from 'fs'
import handlebars from 'handlebars'
import debug from 'debug'

import { addController } from './controller'
import { createSpec } from './openapi'
import { CodeGenControllers } from './types'
import { getRelativeFilePath, resolveProperty } from './utils'
import { resolve } from './resolve'
import { CacheManager, ChangeAnalyzer, RegenerationManager, DependencyGraph } from './cache'

const log = debug('typoa:cache')

export type OpenAPIConfiguration = {
  tsconfigFilePath: string
  /**
   * List of controllers paths
   */
  controllers: string[]
  root?: string
  openapi: {
    /**
     * Where you want the spec to be exported
     * Can be a single file path or an array of file paths
     * The file extension (.json, .yaml, or .yml) determines the output format
     */
    filePath: string | string[]
    /**
     * OpenAPI security schemes to add to the spec
     */
    securitySchemes?: Record<string, OpenAPIV3.SecuritySchemeObject>
    /**
     * OpenAPI service informations to add to the spec
     */
    service: {
      name: string
      version: string
    },
    /**
     * Additional types you want to export in the schemas of the spec
     * (could be useful when using the spec to generate typescript openapi clients...)
     */
    additionalExportedTypeNames?: string[]
    /**
     * If you enable this option we will find every responses
     * with an HTTP code >300 and output it to a markdown
     * table on `info.description`
     */
    outputErrorsToDescription?: {
      enabled: false
    } | {
      enabled: true
      /**
       * Define table columns (name + how value is retrieved)
       */
      tableColumns: {
        name: string
        value: ({
          type: 'path',
          /**
           * Path of data to display in the cell (e.g. `['status_code']` or `['data', 'payload']`)
           */
          value: string[]
        } | {
          type: 'statusCode'
        } | {
          type: 'description'
        })
      }[]
      /**
       * Sort rows by a column
       */
      sortColumn?: string
      /**
       * Ensure unicity via a column value
       */
      uniqueColumn?: string
    }
  },
  router: {
    /**
     * The handlebars template path we use to generate the router file
     */
    templateFilePath?: string
    /**
     * Where you want the express router to be exported
     */
    filePath: string,
    /**
     * The path of the middleware that must be called when @Security()
     * decorator is applied on the route
     * You must export a variable/function named `securityMiddleware`
     */
    securityMiddlewarePath?: string

    /**
     * If `true`, the result will be validated against the schema
     * and any extra properties will be removed.
     */
    validateResponse?: boolean;

    /**
     * Override the module name used for runtime imports inside the generated router
     * Defaults to 'typoa'. Useful for tests to point to local source (e.g. '../../src').
     */
    runtimeImport?: string;
  }
  /**
   * Incremental caching configuration
   */
  cache?: {
    /**
     * Enable incremental caching system
     */
    enabled: boolean
    /**
     * Cache directory path (defaults to '.typoa-cache')
     */
    cacheDir?: string
  }
}

const promiseGlob = promisify(glob)

export async function generate (config: OpenAPIConfiguration) {
  if (config.cache?.enabled) {
    return await generateWithCache(config)
  }
  return await generateWithoutCache(config)
}

/**
 * Safe file operation wrapper with consistent error handling
 */
async function safeFileOperation<T>(
  operation: () => Promise<T>,
  fallback: T,
  context: string
): Promise<T> {
  try {
    return await operation()
  } catch (error) {
    log(`${context}: ${(error as Error).message}`)
    return fallback
  }
}

/**
 * Generate with cache enabled
 */
async function generateWithCache(config: OpenAPIConfiguration): Promise<any> {
  const root = config.root ?? path.dirname(path.resolve(config.tsconfigFilePath))
  const project = new Project({
    compilerOptions: getCompilerOptionsFromTsConfig(config.tsconfigFilePath).options
  })
  project.addSourceFilesFromTsConfig(config.tsconfigFilePath)

  const cacheManager = new CacheManager(config.cache!.cacheDir, root)
  
  // Load existing cache or initialize new one
  const cacheResult = await loadOrInitializeCache(cacheManager, config)
  
  // If no cache exists, perform full generation
  if (cacheResult.isNew) {
    const result = await performFullGenerate(config, project, root, cacheResult.cache)
    await cacheManager.save(cacheResult.cache)
    
    log('Full generation completed and cached')
    return result
  }

  // Check if regeneration is needed
  const updateResult = await validateCacheAndCheckUpdates(config, cacheResult.cache, project)
  
  // Use cached output if no changes detected
  if (!updateResult.requiresRegeneration) {
    log('No changes detected, using cached output')
    return await writeCachedOutput(cacheResult.cache, config, root)
  }

  // Perform incremental or full regeneration
  log(`Changes detected: ${updateResult.reason}`)

  const result = await performIncrementalUpdate(updateResult, cacheResult.cache, project, config, root)
  await cacheManager.save(cacheResult.cache)
  
  return result
}

/**
 * Generate without cache
 */
async function generateWithoutCache(config: OpenAPIConfiguration): Promise<any> {
  const root = config.root ?? path.dirname(path.resolve(config.tsconfigFilePath))
  const project = new Project({
    compilerOptions: getCompilerOptionsFromTsConfig(config.tsconfigFilePath).options
  })
  project.addSourceFilesFromTsConfig(config.tsconfigFilePath)

  return await performFullGenerate(config, project, root)
}

/**
 * Load existing cache or initialize a new one
 */
async function loadOrInitializeCache(cacheManager: CacheManager, config: OpenAPIConfiguration): Promise<{ cache: any; isNew: boolean }> {
  const cache = await cacheManager.load()
  
  if (cache) {
    log('Cache loaded successfully')
    return { cache, isNew: false }
  }

  log('No cache found, initializing new cache')

  // Initialize new cache
  const newCache = {
    version: '1.0.0',
    types: new Map(),
    controllers: new Map(),
    dependencies: new DependencyGraph(),
    files: new Map(),
    openApiSpec: createSpec({ name: config.openapi.service.name, version: config.openapi.service.version }),
    routerContent: '',
    lastFullGeneration: Date.now()
  }

  return { cache: newCache, isNew: true }
}

/**
 * Validate cache and check if updates are needed
 */
async function validateCacheAndCheckUpdates(
  config: OpenAPIConfiguration,
  cache: any,
  project: Project
): Promise<{ requiresRegeneration: boolean; reason?: string; [key: string]: any }> {
  try {
    const changeAnalyzer = new ChangeAnalyzer(project, cache)
    return await checkIfUpdateNeeded(config, cache, changeAnalyzer)
  } catch (error) {
    log(`Cache validation failed: ${(error as Error).message}`)
    return { requiresRegeneration: true, reason: 'Cache validation failed' }
  }
}

/**
 * Perform incremental update or fall back to full regeneration
 */
async function performIncrementalUpdate(
  updateResult: any,
  cache: any,
  project: Project,
  config: OpenAPIConfiguration,
  root: string
): Promise<any> {
  try {
    // Attempt incremental regeneration
    const regenerationManager = new RegenerationManager(cache, project, config)
    const result = await regenerationManager.processChanges(updateResult)
    
    // Always update cache with current file metadata after processing changes
    await syncFileCache(cache, config, project, [])
    
    // Check if incremental regeneration actually produced updates
    if (updateResult.requiresRegeneration && 
        result.regeneratedTypes.size === 0 && 
        result.regeneratedControllers.size === 0) {
      
      log('Incremental regeneration expected updates but produced none, falling back to full regeneration')
      
      return await performFullGenerate(config, project, root, cache)
    }
    
    log(`Incremental regeneration completed in ${result.timeTaken}ms`)
    log(`  Types: ${result.regeneratedTypes.size}`)
    log(`  Controllers: ${result.regeneratedControllers.size}`)
    log(`  Paths: ${result.regeneratedPaths.size}`)
    if (result.skippedImplementationChanges.size > 0) {
      log(`  Skipped: ${result.skippedImplementationChanges.size} implementation changes`)
    }
    
    return result
  } catch (error) {
    log(`Incremental update failed: ${(error as Error).message}, falling back to full regeneration`)
    
    return await performFullGenerate(config, project, root, cache)
  }
}

/**
 * Perform full generation (original logic)
 */
async function performFullGenerate(
  config: OpenAPIConfiguration, 
  project: Project, 
  root: string,
  cache?: any
): Promise<{ spec: OpenAPIV3.Document, codegenControllers: CodeGenControllers, controllersPathByName: Record<string, string> }> {
  // Init spec
  const spec = createSpec({ name: config.openapi.service.name, version: config.openapi.service.version })
  if (typeof config.openapi.securitySchemes !== 'undefined') {
    spec.components!.securitySchemes = config.openapi.securitySchemes
  }

  // Codegen object
  const codegenControllers: CodeGenControllers = {}
  const controllersPathByName: Record<string, string> = {}

  // Iterate over controllers and patch spec
  await Promise.all(config.controllers.map(async controller => {
    const files = await promiseGlob(controller)
    await Promise.all(files.map(async file => {
      const filePath = path.resolve(file)
      const sourceFile = project.getSourceFileOrThrow(filePath)
      const controllers = sourceFile.getClasses()
      for (const controller of controllers) {
        const routeDecorator = controller.getDecorator('Route')
        if (routeDecorator === undefined) continue // skip
        addController(controller, spec, codegenControllers, config.router)
        controllersPathByName[controller.getName()!] = filePath
      }
    }))
  }))

  // additional exported type names
  for (const typeName of config.openapi.additionalExportedTypeNames ?? []) {
    const sourceFiles = project.getSourceFiles()
    const declarations = sourceFiles
      .map(file => ({ file: file.getFilePath(), declaration: file.getExportedDeclarations().get(typeName)?.[0] }))
      .filter(({ declaration }) => typeof declaration !== 'undefined') as { declaration: ExportedDeclarations, file: string }[]
    if (declarations.length === 0) {
      throw new Error(`Unable to find the additional exported type named '${typeName}'`)
    }
    if (declarations.length > 1) {
      throw new Error(`We found multiple references for the additional exported type named '${typeName}' in ${declarations.map(({ file }) => file).join(', ')}`)
    }
    const declaration = declarations[0].declaration as TypeAliasDeclaration | ClassDeclaration | InterfaceDeclaration
    // Add to spec
    const name = declaration.getName()!
    const type = declaration.getType()
    const resolved = resolve(type.isAny() ? declaration.getSymbol()?.getDeclaredType() ?? type : type, spec)
    if (!('$ref' in resolved) || resolved.$ref.substr('#/components/schemas/'.length) !== name) {
      spec.components!.schemas![name] = resolved
    }
  }

  // Export all responses
  if (typeof config.openapi.outputErrorsToDescription !== 'undefined' && config.openapi.outputErrorsToDescription.enabled === true) {
    const errorsConfig = config.openapi.outputErrorsToDescription
    const tableColumns = errorsConfig.tableColumns
    const methods = ['get', 'patch', 'put', 'delete', 'post', 'head', 'options'] as const
    const responses = Object.values(spec.paths)
      .map((path) => {
        return methods.map(method => path[method]?.responses ?? {})
      }).flat()
      .reduce<{ code: number, response: OpenAPIV3.ResponseObject }[]>((list, responses) => {
        for (const code in responses) {
          // note: we don't generate responses with $ref so we can use `as`
          list.push({ code: parseInt(code, 10), response: responses[code] as OpenAPIV3.ResponseObject })
        }
        return list
      }, [])
    let rows = responses
      .filter((response) => response.code > 300 && typeof response.response.content !== 'undefined')
      .map((response) => {
        const content = response.response.content!['application/json'].schema
        if (typeof content === 'undefined') {
          return undefined
        }
        const buildRow = (content: OpenAPIV3.ReferenceObject | OpenAPIV3.ArraySchemaObject | OpenAPIV3.NonArraySchemaObject) => tableColumns.map(({ value }) => {
          switch (value.type) {
            case 'path':
              const resolved = resolveProperty(content, spec.components!, value.value)
              if (resolved.meta.isObject) {
                return '```' + String(resolved.value) + '```'
              }
              return String(resolved.value)
            case 'description':
              return String(response.response.description)
            case 'statusCode':
              return String(response.code)
          }
        })
        if ('oneOf' in content && typeof content.oneOf !== 'undefined') {
          return content.oneOf.map((content) => buildRow(content))
        }
        return [buildRow(content)]
      })
      .flat(1)
      .filter(content => typeof content !== 'undefined') as string[][]
    if (typeof errorsConfig.sortColumn === 'string') {
      const columnIndex = tableColumns.findIndex(column => column.name === errorsConfig.sortColumn)
      rows = rows.sort((a, b) => {
        const aValue = a[columnIndex]
        const bValue = b[columnIndex]
        if (String(parseFloat(aValue)) === aValue && String(parseFloat(bValue)) === bValue) {
          return parseFloat(aValue) - parseFloat(bValue)
        }
        return aValue.localeCompare(bValue)
      })
    }
    if (typeof errorsConfig.uniqueColumn === 'string') {
      const columnIndex = tableColumns.findIndex(column => column.name === errorsConfig.uniqueColumn)
      rows = rows.filter((row, i) => rows.findIndex(r => r[columnIndex] === row[columnIndex]) === i)
    }
    const headers = tableColumns.map(column => column.name)
    const markdown = `| ${headers.join(' | ')} |\n` +
      `| ${new Array(headers.length).fill(':---').join(' | ')} |\n` +
      rows.map(row => `| ${row.join(' | ')} |`).join('\n')
    spec.info.description = `# Errors\n${markdown}`
  }

  // Write OpenAPI file(s)
  const jsonContent = JSON.stringify(spec, null, '\t')
  
  // Convert filePath to array for unified processing
  const filePaths = Array.isArray(config.openapi.filePath) 
    ? config.openapi.filePath 
    : [config.openapi.filePath];
  
  // Process each file path
  for (const filePath of filePaths) {
    const resolvedPath = path.resolve(root, filePath);
    
    // Determine format based on file extension
    if (filePath.toLowerCase().endsWith('.yaml') || filePath.toLowerCase().endsWith('.yml')) {
      const yamlContent = YAML.stringify(JSON.parse(jsonContent), 10) // use json anyway to remove undefined
      await fs.promises.writeFile(resolvedPath, yamlContent);
    } else {
      // Default to JSON for any other extension or no extension
      await fs.promises.writeFile(resolvedPath, jsonContent);
    }
  }

  // Codegen
  const templateFilePath = config.router.templateFilePath ?
    path.resolve(root, config.router.templateFilePath) :
    path.resolve(__dirname, './template/express.ts.hbs')
  handlebars.registerHelper('json', (context: any) => {
    return JSON.stringify(context)
  })
  const templateContent = await fs.promises.readFile(templateFilePath)
  const compiledTemplate = handlebars.compile(templateContent.toString(), { noEscape: true }) // don't escape json strings
  const routerFilePath = path.resolve(root, config.router.filePath)
  const routerFileContent = compiledTemplate({
    securityMiddleware: config.router.securityMiddlewarePath ? getRelativeFilePath(
      path.dirname(routerFilePath),
      path.resolve(root, config.router.securityMiddlewarePath)
    ) : undefined,
    validateResponse: config.router.validateResponse,
    runtimeImport: config.router.runtimeImport ?? process.env.TYPOA_RUNTIME_IMPORT ?? 'typoa',
    controllers: Object.keys(codegenControllers).map((controllerName) => {
      return {
        name: controllerName,
        path: getRelativeFilePath(path.dirname(routerFilePath), controllersPathByName[controllerName]),
        methods: codegenControllers[controllerName].map((method) => {
          if (method.bodyDiscriminator) { // Update path
            method.bodyDiscriminator.path = getRelativeFilePath(
              path.dirname(routerFilePath),
              method.bodyDiscriminator.path
            )
          }
          return method
        })
      }
    }),
    schemas: spec.components!.schemas,
    middlewares: Object
      .values(codegenControllers)
      .flatMap(controller => controller.flatMap(method => method.middlewares || []))
      .filter((middleware, index, self) => self.findIndex(m => m.name === middleware.name) === index)
  })

  await fs.promises.writeFile(routerFilePath, routerFileContent)

  // Update cache if provided
  if (cache) {
    cache.openApiSpec = spec
    cache.routerContent = routerFileContent
    
    // Populate cache with file information
    await populateCache(cache, config, project, root)
  }

  return { spec, codegenControllers, controllersPathByName }
}

/**
 * Update cache file metadata with improved error handling
 */
async function syncFileCache(cache: any, config: OpenAPIConfiguration, project: Project, filePaths: string[]): Promise<void> {
  const allFiles = await getAllControllerFiles(config)
  
  for (const filePath of allFiles) {
    await updateFileInCache(cache, filePath, config, project)
  }
}

/**
 * Get all controller files from patterns
 */
async function getAllControllerFiles(config: OpenAPIConfiguration): Promise<string[]> {
  const fileArrays = await Promise.all(
    config.controllers.map(pattern => promiseGlob(pattern))
  )
  return fileArrays.flat().map(file => path.resolve(file))
}

/**
 * Update a single file in cache with consistent error handling
 */
async function updateFileInCache(
  cache: any,
  filePath: string,
  config: OpenAPIConfiguration,
  project: Project
): Promise<void> {
  const fileMetadata = await safeFileOperation(
    () => getFileMetadata(filePath),
    null,
    `Failed to get metadata for ${filePath}`
  )

  if (!fileMetadata) {
    // File was deleted, remove from cache
    cache.files.delete(filePath)
    return
  }

  // Analyze imports for dependency tracking
  const sourceFile = project.getSourceFile(filePath)
  const fileImports = sourceFile 
    ? await safeFileOperation(
        () => analyzeFileImports(filePath, sourceFile, config),
        new Set<string>(),
        `Failed to analyze imports for ${filePath}`
      )
    : new Set<string>()
  
  // Update cache entry
  cache.files.set(filePath, {
    ...cache.files.get(filePath),
    lastModified: fileMetadata.lastModified,
    contentHash: fileMetadata.contentHash,
    imports: fileImports
  })
  
  // Track dependency files in cache
  await updateDependencyFiles(cache, fileImports, config)
}

/**
 * Get file metadata (stats and content hash)
 */
async function getFileMetadata(filePath: string): Promise<{ lastModified: number; contentHash: string }> {
  const stats = await fs.promises.stat(filePath)
  const content = await fs.promises.readFile(filePath, 'utf-8')
  const contentHash = require('crypto').createHash('sha256').update(content).digest('hex')
  
  return {
    lastModified: stats.mtimeMs,
    contentHash
  }
}

/**
 * Resolve import path to absolute file path
 */
async function resolveImportPath(filePath: string, moduleSpecifier: string): Promise<string | null> {
  try {
    const resolvedPath = path.resolve(path.dirname(filePath), moduleSpecifier)
    
    // If the resolved path ends with .js, try replacing it with TypeScript extensions
    if (resolvedPath.endsWith('.js')) {
      const basePath = resolvedPath.slice(0, -3)
      for (const ext of ['.ts', '.tsx']) {
        const fullPath = basePath + ext
        if (fs.existsSync(fullPath)) {
          return fullPath
        }
      }
    }
    
    // Try appending extensions
    for (const ext of ['.ts', '.js', '.tsx', '.jsx']) {
      const fullPath = resolvedPath + ext
      if (fs.existsSync(fullPath)) {
        return fullPath
      }
    }
  } catch (error) {
    // Ignore resolution failures
  }
  
  return null
}

/**
 * Update dependency files in cache
 */
async function updateDependencyFiles(cache: any, fileImports: Set<string>, config: OpenAPIConfiguration): Promise<void> {
  for (const depPath of fileImports) {
    if (cache.files.has(depPath)) continue
    
    const depMetadata = await safeFileOperation(
      () => getFileMetadata(depPath),
      null,
      `Failed to get dependency metadata for ${depPath}`
    )
    
    if (depMetadata) {
      cache.files.set(depPath, {
        lastModified: depMetadata.lastModified,
        contentHash: depMetadata.contentHash,
        exportedTypes: new Map(),
        controllers: new Set(),
        imports: new Set()
      })
    }
  }
}

/**
 * Populate cache with file, type, and controller information using simplified approach
 */
async function populateCache(cache: any, config: OpenAPIConfiguration, project: Project, root: string): Promise<void> {
  const allFiles = await getAllControllerFiles(config)
  
  // Process files with better error handling
  const results = await Promise.allSettled(
    allFiles.map(filePath => populateCacheForFile(cache, filePath, config, project))
  )
  
  // Log any failures
  const failures = results.filter(r => r.status === 'rejected') as PromiseRejectedResult[]
  if (failures.length > 0) {
    log(`Failed to populate cache for ${failures.length} files:`)
    failures.forEach(failure => log(`  ${failure.reason}`))
  }
  
  const successes = results.filter(r => r.status === 'fulfilled').length
  log(`Successfully populated cache for ${successes}/${allFiles.length} files`)
}

/**
 * Populate cache for a single file
 */
async function populateCacheForFile(
  cache: any,
  filePath: string,
  config: OpenAPIConfiguration,
  project: Project
): Promise<void> {
  // Get file metadata
  const fileMetadata = await getFileMetadata(filePath)
  
  // Create initial file cache entry
  const fileCacheEntry = {
    lastModified: fileMetadata.lastModified,
    contentHash: fileMetadata.contentHash,
    exportedTypes: new Map(),
    controllers: new Set(),
    imports: new Set()
  }
  
  cache.files.set(filePath, fileCacheEntry)
  
  // Process TypeScript analysis
  const sourceFile = project.getSourceFile(filePath)
  if (!sourceFile) {
    log(`No source file found for ${filePath}, skipping TypeScript analysis`)
    return
  }
  
  // Process API signature and imports
  await processFileStructure(cache, filePath, sourceFile, config)
  
  // Process controllers and methods
  await processControllers(cache, filePath, sourceFile, config)
}

/**
 * Process file structure (API signature and imports)
 */
async function processFileStructure(
  cache: any,
  filePath: string,
  sourceFile: any,
  config: OpenAPIConfiguration
): Promise<void> {
  // Compute API signature for fast structural comparison
  const controllerClasses = sourceFile.getClasses().filter((c: any) => c.getDecorator('Route'))
  if (controllerClasses.length > 0) {
    const apiSignature = computeApiSignature(controllerClasses)
    cache.files.get(filePath)!.apiSignature = apiSignature
  }
  
  // Analyze and resolve imports
  const fileImports = await analyzeFileImports(filePath, sourceFile, config)
  cache.files.get(filePath)!.imports = fileImports
  
  // Update dependency files in cache
  await updateDependencyFiles(cache, fileImports, config)
}

/**
 * Analyze file imports using sourceFile directly
 */
async function analyzeFileImports(
  filePath: string,
  sourceFile: any,
  config: OpenAPIConfiguration
): Promise<Set<string>> {
  const fileImports = new Set<string>()
  
  if (!config.cache?.enabled) return fileImports
  
  const imports = sourceFile.getImportDeclarations()
  
  log(`Analyzing ${imports.length} imports in ${filePath}`)
  
  const importResolutions = await Promise.allSettled(
    imports.map(async (importDecl: any) => {
      const moduleSpecifier = importDecl.getModuleSpecifierValue()
      
      // Only process relative imports
      if (!moduleSpecifier.startsWith('.')) return null
      
      const resolvedPath = await resolveImportPath(filePath, moduleSpecifier)
      return resolvedPath
    })
  )
  
  importResolutions.forEach(result => {
    if (result.status === 'fulfilled' && result.value) {
      fileImports.add(result.value)
      log(`Added dependency: ${result.value}`)
    }
  })
  
  return fileImports
}

/**
 * Process controllers and their methods
 */
async function processControllers(
  cache: any,
  filePath: string,
  sourceFile: any,
  config: OpenAPIConfiguration
): Promise<void> {
  const controllers = sourceFile.getClasses()
  
  for (const controller of controllers) {
    const routeDecorator = controller.getDecorator('Route')
    if (!routeDecorator) continue
    
    const controllerName = controller.getName()
    if (!controllerName) continue
    
    // Add controller to file cache
    cache.files.get(filePath)!.controllers.add(controllerName)
    
    // Process controller methods
    await processControllerMethods(cache, controller, controllerName, filePath, config)
  }
}

/**
 * Process methods of a controller
 */
async function processControllerMethods(
  cache: any,
  controller: any,
  controllerName: string,
  filePath: string,
  config: OpenAPIConfiguration
): Promise<void> {
  const httpDecorators = ['Get', 'Post', 'Put', 'Delete', 'Patch', 'Head', 'Options']
  const methods = controller.getMethods()
  
  for (const method of methods) {
    const httpDecorator = httpDecorators
      .map(name => method.getDecorator(name))
      .find(d => d !== undefined)
    
    if (!httpDecorator) continue
    
    const methodName = method.getName()
    const controllerId = `${controllerName}#${methodName}`
    
    // Create method-level cache entry with safe operations
    const methodCacheEntry = await safeFileOperation(
      () => createMethodCacheEntry(method, controllerId, controllerName, httpDecorator, filePath),
      null,
      `Failed to create cache entry for method ${controllerId}`
    )
    
    if (methodCacheEntry) {
      cache.controllers.set(controllerId, methodCacheEntry)
    }
  }
}

/**
 * Create cache entry for a controller method
 */
async function createMethodCacheEntry(
  method: any,
  controllerId: string,
  controllerName: string,
  httpDecorator: any,
  filePath: string
): Promise<any> {
  const methodBody = method.getBody()?.getText() || ''
  const implementationHash = require('crypto').createHash('sha256').update(methodBody).digest('hex')
  
  return {
    id: controllerId,
    signature: method.getSignature(),
    implementationHash,
    metadata: {
      className: controllerName,
      method: method.getName(),
      httpMethod: httpDecorator.getName(),
      returnType: method.getReturnType().getSymbol()?.getName() || 'void'
    },
    sourceFile: filePath,
    lastModified: Date.now(),
    route: '', // Will be filled by controller processing
    httpMethod: httpDecorator.getName(),
    decorators: new Map(),
    parameterTypes: new Map(),
    typeDependencies: new Set()
  }
}

/**
 * Check if update is needed using simplified validation logic
 */
async function checkIfUpdateNeeded(
  config: OpenAPIConfiguration,
  cache: any,
  changeAnalyzer: any
): Promise<any> {
  const controllers = await getAllControllerFiles(config)
  
  const overallAnalysis: any = {
    requiresRegeneration: false,
    affectedTypes: new Set(),
    affectedControllers: new Set(),
    changes: {
      typeSignatureChanges: new Map(),
      controllerMetadataChanges: new Map(),
      implementationOnlyChanges: new Set()
    }
  }
  
  // Check each controller file
  for (const controllerPath of controllers) {
    const fileResult = await validateSingleFile(controllerPath, cache, config, changeAnalyzer)
    
    log(`File validation result for ${controllerPath}: requiresRegeneration=${fileResult.requiresRegeneration}`)
    
    if (fileResult.requiresRegeneration) {
      // Early return if any file requires regeneration
      overallAnalysis.requiresRegeneration = true
      overallAnalysis.reason = fileResult.reason
      
      log(`Setting overall analysis to require regeneration: ${fileResult.reason}`)
      
      // Merge analysis results
      mergeAnalysisResults(overallAnalysis, fileResult)
      break // Early exit on first major change
    }
    
    // Accumulate implementation-only changes
    if (fileResult.changes?.implementationOnlyChanges?.size > 0) {
      fileResult.changes.implementationOnlyChanges.forEach((c: any) => 
        overallAnalysis.changes.implementationOnlyChanges.add(c))
    }
  }
  
  log(`Overall analysis result: requiresRegeneration=${overallAnalysis.requiresRegeneration}`)
  
  return overallAnalysis
}

/**
 * Validate a single file for changes
 */
async function validateSingleFile(
  filePath: string,
  cache: any,
  config: OpenAPIConfiguration,
  changeAnalyzer: any
): Promise<any> {
  // Check if file exists
  const fileStats = await safeFileOperation(
    () => fs.promises.stat(filePath),
    null,
    `Failed to stat file ${filePath}`
  )
  
  if (!fileStats) {
    return {
      requiresRegeneration: true,
      reason: `File ${filePath} was deleted or is inaccessible`
    }
  }
  
  const cachedFile = cache.files.get(filePath)
  
  // File not in cache - needs regeneration
  if (!cachedFile) {
    return {
      requiresRegeneration: true,
      reason: `File ${filePath} not found in cache`
    }
  }
  
  // Quick timestamp check - if file wasn't modified, check dependencies only
  if (fileStats.mtimeMs <= cachedFile.lastModified) {
    return await checkFileDependencies(filePath, cache, config)
  }
  
  log(`File ${filePath} timestamp changed: ${fileStats.mtimeMs} > ${cachedFile.lastModified}`)
  
  // File was modified, check content
  const contentChanged = await checkFileContentChanged(filePath, cachedFile, config)
  if (!contentChanged) {
    log(`File ${filePath} timestamp changed but content is identical, updating cache timestamp`)
    // Update timestamp in cache to prevent future false positives
    await updateCacheTimestamp(cache, filePath, fileStats.mtimeMs)
    return await checkFileDependencies(filePath, cache, config)
  }
  
  log(`File ${filePath} content changed, performing expensive analysis`)
  
  // Content changed, perform expensive analysis
  return await performExpensiveAnalysis(filePath, changeAnalyzer, cache, config)
}

/**
 * Check if file content actually changed
 */
async function checkFileContentChanged(
  filePath: string,
  cachedFile: any,
  config: OpenAPIConfiguration
): Promise<boolean> {
  const currentContent = await safeFileOperation(
    () => fs.promises.readFile(filePath, 'utf-8'),
    '',
    `Failed to read file ${filePath}`
  )
  
  if (!currentContent) return true // Assume changed if can't read
  
  const currentHash = require('crypto').createHash('sha256').update(currentContent).digest('hex')
  return cachedFile.contentHash !== currentHash
}

/**
 * Update cache timestamp without expensive analysis
 */
async function updateCacheTimestamp(cache: any, filePath: string, newTimestamp: number): Promise<void> {
  const cachedFile = cache.files.get(filePath)
  if (cachedFile) {
    cache.files.set(filePath, {
      ...cachedFile,
      lastModified: newTimestamp
    })
  }
}

/**
 * Check file dependencies for changes
 */
async function checkFileDependencies(
  filePath: string,
  cache: any,
  config: OpenAPIConfiguration
): Promise<any> {
  const cachedFile = cache.files.get(filePath)
  if (!cachedFile?.imports) {
    return { requiresRegeneration: false }
  }
  
  for (const dependencyPath of cachedFile.imports) {
    const dependencyResult = await validateDependencyFile(dependencyPath, cache, config)
    if (dependencyResult.requiresRegeneration) {
      return dependencyResult
    }
  }
  
  return { requiresRegeneration: false }
}

/**
 * Validate a dependency file
 */
async function validateDependencyFile(
  dependencyPath: string,
  cache: any,
  config: OpenAPIConfiguration
): Promise<any> {
  const depStats = await safeFileOperation(
    () => fs.promises.stat(dependencyPath),
    null,
    `Failed to stat dependency ${dependencyPath}`
  )
  
  if (!depStats) {
    return {
      requiresRegeneration: true,
      reason: `Dependency file ${dependencyPath} is inaccessible`
    }
  }
  
  const cachedDep = cache.files.get(dependencyPath)
  if (!cachedDep) {
    return {
      requiresRegeneration: true,
      reason: `Dependency file ${dependencyPath} not in cache`
    }
  }
  
  if (depStats.mtimeMs <= cachedDep.lastModified) {
    return { requiresRegeneration: false }
  }
  
  // Check if dependency content changed
  const contentChanged = await checkFileContentChanged(dependencyPath, cachedDep, config)
  if (contentChanged) {
    return {
      requiresRegeneration: true,
      reason: `Dependency file ${dependencyPath} changed`
    }
  }
  
  // Update dependency timestamp
  await updateCacheTimestamp(cache, dependencyPath, depStats.mtimeMs)
  return { requiresRegeneration: false }
}

/**
 * Perform expensive analysis when content definitely changed
 */
async function performExpensiveAnalysis(
  filePath: string,
  changeAnalyzer: any,
  cache: any,
  config: OpenAPIConfiguration
): Promise<any> {
  try {
    log(`Performing expensive analysis on ${filePath}`)
    
    const analysis = await changeAnalyzer.analyzeFileChange(filePath)
    
    log(`Analysis result for ${filePath}: requiresRegeneration=${analysis.requiresRegeneration}`)
    if (analysis.reason) {
      log(`Analysis reason: ${analysis.reason}`)
    }
    
    if (analysis.requiresRegeneration) {
      return analysis
    }
    
    // Update cache for implementation-only changes
    if (analysis.changes?.implementationOnlyChanges?.size > 0) {
      await updateFileMetadataAfterAnalysis(cache, filePath, config)
    }
    
    return analysis
  } catch (error) {
    log(`Analysis failed for ${filePath}: ${(error as Error).message}`)
    
    return {
      requiresRegeneration: true,
      reason: `Failed to analyze ${filePath}: ${(error as Error).message}`
    }
  }
}

/**
 * Update file metadata after analysis
 */
async function updateFileMetadataAfterAnalysis(
  cache: any,
  filePath: string,
  config: OpenAPIConfiguration
): Promise<void> {
  const metadata = await safeFileOperation(
    () => getFileMetadata(filePath),
    null,
    `Failed to update metadata for ${filePath}`
  )
  
  if (metadata) {
    const existingEntry = cache.files.get(filePath) || {}
    cache.files.set(filePath, {
      ...existingEntry,
      lastModified: metadata.lastModified,
      contentHash: metadata.contentHash
    })
  }
}

/**
 * Merge analysis results
 */
function mergeAnalysisResults(overall: any, fileResult: any): void {
  if (fileResult.affectedTypes) {
    fileResult.affectedTypes.forEach((t: any) => overall.affectedTypes.add(t))
  }
  
  if (fileResult.affectedControllers) {
    fileResult.affectedControllers.forEach((c: any) => overall.affectedControllers.add(c))
  }
  
  if (fileResult.changes) {
    const { typeSignatureChanges, controllerMetadataChanges, implementationOnlyChanges } = fileResult.changes
    
    if (typeSignatureChanges) {
      typeSignatureChanges.forEach((v: any, k: any) => 
        overall.changes.typeSignatureChanges.set(k, v))
    }
    
    if (controllerMetadataChanges) {
      controllerMetadataChanges.forEach((v: any, k: any) => 
        overall.changes.controllerMetadataChanges.set(k, v))
    }
    
    if (implementationOnlyChanges) {
      implementationOnlyChanges.forEach((c: any) => 
        overall.changes.implementationOnlyChanges.add(c))
    }
  }
}

/**
 * Write cached OpenAPI spec and router to files and return expected structure
 */
async function writeCachedOutput(
  cache: any,
  config: OpenAPIConfiguration,
  root: string
): Promise<{ spec: any, codegenControllers: any, controllersPathByName: Record<string, string> }> {
  // Write OpenAPI spec
  const filePaths = Array.isArray(config.openapi.filePath)
    ? config.openapi.filePath
    : [config.openapi.filePath]
  
  for (const filePath of filePaths) {
    const resolvedPath = path.resolve(root, filePath)
    
    if (filePath.toLowerCase().endsWith('.yaml') || filePath.toLowerCase().endsWith('.yml')) {
      const yamlContent = YAML.stringify(cache.openApiSpec, 10)
      await fs.promises.writeFile(resolvedPath, yamlContent)
    } else {
      const jsonContent = JSON.stringify(cache.openApiSpec, null, '\t')
      await fs.promises.writeFile(resolvedPath, jsonContent)
    }
  }
  
  // Write router
  const routerFilePath = path.resolve(root, config.router.filePath)
  await fs.promises.writeFile(routerFilePath, cache.routerContent)
  
  // Return the expected structure from cache
  // Note: We need to reconstruct these from cache data
  const codegenControllers = reconstructCodegenControllers(cache)
  const controllersPathByName = reconstructControllersPathByName(cache)
  
  return {
    spec: cache.openApiSpec,
    codegenControllers,
    controllersPathByName
  }
}

/**
 * Reconstruct codegen controllers from cache
 */
function reconstructCodegenControllers(cache: any): any {
  const codegenControllers: any = {}
  
  // Group controller methods by class name
  for (const [, controllerData] of cache.controllers) {
    const className = controllerData.metadata?.className
    if (!className) continue
    
    if (!codegenControllers[className]) {
      codegenControllers[className] = []
    }
    
    // Add method data to controller
    codegenControllers[className].push({
      name: controllerData.metadata.method,
      httpMethod: controllerData.httpMethod,
      route: controllerData.route,
      // Add other necessary fields based on what's available in cache
      ...controllerData
    })
  }
  
  return codegenControllers
}

/**
 * Reconstruct controllers path by name from cache
 */
function reconstructControllersPathByName(cache: any): Record<string, string> {
  const controllersPathByName: Record<string, string> = {}
  
  // Extract controller names and their file paths
  for (const [filePath, fileData] of cache.files) {
    if (fileData.controllers) {
      for (const controllerName of fileData.controllers) {
        controllersPathByName[controllerName] = filePath
      }
    }
  }
  
  return controllersPathByName
}

/**
 * Compute a fast signature of the API surface (methods, decorators, basic types)
 * without expensive TypeScript type analysis
 */
function computeApiSignature(controllers: any[]): string {
  const signatures: string[] = []
  
  for (const controller of controllers) {
    const routeDecorator = controller.getDecorator('Route')
    const routePath = routeDecorator?.getArguments()[0]?.getText() || ''
    
    // Controller signature
    signatures.push(`controller:${controller.getName()}:${routePath}`)
    
    // Method signatures
    const methods = controller.getMethods()
    for (const method of methods) {
      // Check for HTTP decorators
      const httpDecorators = ['Get', 'Post', 'Put', 'Delete', 'Patch', 'Head', 'Options']
      const httpDecorator = httpDecorators
        .map(name => method.getDecorator(name))
        .find(d => d !== undefined)
      
      if (httpDecorator) {
        const methodPath = httpDecorator.getArguments()[0]?.getText() || ''
        const paramCount = method.getParameters().length
        const returnTypeText = method.getReturnTypeNode()?.getText() || 'void'
        
        // Fast signature: httpMethod:path:paramCount:returnType
        const methodSig = `${httpDecorator.getName()}:${methodPath}:${paramCount}:${returnTypeText}`
        signatures.push(`method:${controller.getName()}.${method.getName()}:${methodSig}`)
        
        // Security/middleware decorators
        const securityDecorators = ['Security', 'Middleware']
        for (const decoratorName of securityDecorators) {
          const decorator = method.getDecorator(decoratorName)
          if (decorator) {
            const args = decorator.getArguments().map((a: any) => a.getText()).join(',')
            signatures.push(`decorator:${controller.getName()}.${method.getName()}:${decoratorName}:${args}`)
          }
        }
      }
    }
  }
  
  return require('crypto').createHash('sha256').update(signatures.sort().join('|')).digest('hex')
}

export * from './runtime/decorators'
export * from './runtime/interfaces'
export * as RuntimeResponse from './runtime/response'
export * as Validator from './runtime/validator'
