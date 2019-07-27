const { logger } = require('@vuepress/shared-utils')
const exec = require('child_process').exec
const fs = require('fs-extra')
const path = require('path')
const { promisify } = require('util')

const { linkConverterPlugin, typeAutolink, vueComponentPatch } = require('./lib/utils/markdown')
const { metadataService, getLinkForKeyPath } = require('./lib/metadata/service')
const MetadataProcessor = require('./lib/metadata/processor')

const execAsync = promisify(exec)

let metadataProcessed = false
const processed = {}

/**
 * Titanium API reference documentation plugin
 */
module.exports = (options = {}, context) => {
  const pluginName = 'titanium/apidocs'

  const versionsFilePath = path.join(context.sourceDir, '.vuepress', 'versions.json')
  let versions = []
  if (fs.existsSync(versionsFilePath)) {
    versions = JSON.parse(fs.readFileSync(versionsFilePath).toString())
  }

  metadataService.loadMetadata(options, context, versions)

  const pluginConfig = {
    name: pluginName,

    plugins: [
      [
        '@vuepress/register-components',
        {
          componentsDir: path.join(__dirname, 'global-components')
        }
      ]
    ],

    alias: {
      '@apidocs': __dirname
    },

    /**
     * Extend page data of pages under /api/ with metadata key and adds additonal
     * headers to the page.
     *
     * We also use this plugin option to process the whole metadata once, rendering
     * any markdown in it and cellecting the additional page headers.
     *
     * @param {Page} page
     */
    extendPageData (page) {
      if (!metadataProcessed) {
        processMetadata(context, versions)
        metadataProcessed = true
      }

      if (!/^(\/[\w.\-]+)?\/api\//.test(page.regularPath)) {
        return
      }

      page.frontmatter.layout = 'ApiLayout'
      page.frontmatter.sidebarDepth = 0

      const typeName = page.frontmatter.metadataKey || page.title
      const version = page.version || 'next'
      const metadata = metadataService.findMetadata(typeName, version)

      if (!metadata) {
        logger.warn(`no metadata found for type ${typeName} of API page ${page.path}`)
        return
      }

      page.metadataKey = typeName
      page.frontmatter.pageClass = 'api-page'

      if (processed[version] && processed[version][typeName]) {
        const metadataProcessor = processed[version][typeName]
        metadataProcessor.appendAdditionalHeaders(page)
        return
      }

      logger.warn(`no metadata found for type ${typeName} of API page ${page.path}`)
    },

    /**
     * Create dynamic module with processed metadata which is used in webpack server entry
     * to pre-populate the store
     */
    async clientDynamicModules () {
      // @fixme: we can only write one dynamic module per plugin so we need to do
      // the other one manually
      const typeLinks = {}
      for (const version of metadataService.versions) {
        if (!metadataService.metadata[version]) {
          continue
        }
        Object.keys(metadataService.metadata[version]).forEach(name => {
          if (!typeLinks[name]) {
            typeLinks[name] = getLinkForKeyPath(name, '/').path
          }
        })
      }
      await context.writeTemp(
        `dynamic/type-links.js`,
        `/**
 * Generated by "${pluginName}"
 */
export default ${JSON.stringify(typeLinks)}\n\n`.trim()
      )

      return {
        name: 'metadata.js',
        content: `export default ${JSON.stringify(metadataService.metadata)}`
      }
    },

    /**
     * Enhance the Koa dev server and serve api metadata directly from memory
     */
    beforeDevServer (app) {
      app.use((req, res, next) => {
        if (!req.accepts('json')) {
          res.status(406)
          return
        }

        const metadataRoutePattern = /\/([\w.]+)\/([\w.]+).json$/
        const match = req.path.match(metadataRoutePattern)
        if (!match) {
          return next()
        }

        const version = match[1]
        const typeName = match[2]
        const metadata = findMetadataWithLowerCasedKey(typeName, version)
        if (!metadata) {
          return next()
        }

        res.json(metadata)
      })
    },

    /**
     * Add various plugins to markdown-it that are required to properly render links
     * between types.
     */
    chainMarkdown (config) {
      config
        .plugin('convert-type-link')
        .use(linkConverterPlugin)

      config
        .plugin('type-autolink')
        .use(typeAutolink)

      config
        .plugin('vue-component-patch')
        .use(vueComponentPatch)
    },

    /**
     * Replace webpack entry scripts to support Vuex which serves as the metadata store
     */
    chainWebpack (config, isServer) {
      if (isServer) {
        config
          .entry('app')
          .clear()
          .add(path.resolve(__dirname, 'lib/webpack/serverEntry.js'))
      } else {
        config
          .entry('app')
          .clear()
          .add(path.resolve(__dirname, 'lib/webpack/clientEntry.js'))
      }
    },

    /**
     * Split metadata per type and generate a JSON file for each one that gets
     * loaded by Vuex on subsequent page loads once Vue takes over on the client.
     */
    async generated () {
      // @todo check context.markdown.$data.typeLinks for existence

      const tempMetadataPath = path.resolve(context.tempPath, 'metadata')
      fs.ensureDirSync(tempMetadataPath)
      for (const version in processed) {
        fs.ensureDirSync(path.join(tempMetadataPath, version))
        for (const typeName in processed[version]) {
          const metadata = metadataService.findMetadata(typeName, version)
          const destPath = path.join(tempMetadataPath, version, `${typeName.toLowerCase()}.json`)
          fs.writeFileSync(destPath, JSON.stringify(metadata))
        }
      }

      await fs.copy(tempMetadataPath, path.resolve(context.outDir, 'metadata'))
    },

    /**
     * Extends the VuePress CLI with a new command to easily generate API metadata from
     * a set of input directories.
     */
    extendCli (cli) {
      cli
        .command('metadata <targetDir> [...inputPaths]', 'Generate required metadata for the API reference docs')
        .option('-o <dir>', 'Output directory. Defaults to <targetDir>/api/')
        .action(async (targetDir, inputPaths, options) => {
          if (inputPaths.length === 0) {
            throw new Error('Please specify at least one path to a folder containing API docs.')
          }

          const outputPath = options.o ? path.resolve(options.o) : path.resolve(context.sourceDir, 'api')
          const docgenMainScript = require.resolve('titanium-docgen')
          const command = [
            'node',
            docgenMainScript,
            '-f', 'json-raw',
            inputPaths.shift(),
            ...inputPaths.reduce((acc, cur) => {
              acc.push('-a', cur)
              return acc
            }, []),
            '-o', outputPath
          ]
          logger.wait('Generating API metadata file...')
          try {
            logger.debug(`Running command ${command.join(' ')}`)
            await execAsync(command.join(' '))
            logger.success(`Done! Metadata file generated to ${path.join(outputPath, 'api.json')}`)
          } catch (e) {
            logger.error('Failed to generate API metadata.')
            throw e
          }
        })
    }
  }

  if (!options.disableStoreSetup) {
    pluginConfig.enhanceAppFiles = path.resolve(__dirname, 'lib', 'enhanceApp.js')
  }

  return pluginConfig
}

function processMetadata (context, versions) {
  const md = context.markdown
  for (const version of Object.keys(metadataService.metadata)) {
    processed[version] = processed[version] || {}
    for (const typeName of Object.keys(metadataService.metadata[version])) {
      if (processed[version][typeName]) {
        continue
      }

      const metadata = metadataService.metadata[version][typeName]
      const metadataProcessor = new MetadataProcessor({
        md,
        context,
        version,
        versions
      })
      metadataProcessor.transoformMetadataAndCollectHeaders(metadata)
      processed[version][typeName] = metadataProcessor
    }
  }
}

function findMetadataWithLowerCasedKey (lowerCasedTypeName, version) {
  const typesMetadata = metadataService.metadata[version]
  for (const typeName in typesMetadata) {
    if (typeName.toLowerCase() === lowerCasedTypeName) {
      return typesMetadata[typeName]
    }
  }

  return null
}
