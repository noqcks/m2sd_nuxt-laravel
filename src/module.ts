import { Module, Configuration } from '@nuxt/types'
import { NuxtRouteConfig } from '@nuxt/types/config/router'

import fs from 'fs-extra'
import path from 'path'
import execa from 'execa'
import { URL } from 'url'
import { EOL } from 'os'

import { moduleKey, laravelAppEnv, nuxtOutputEnv } from './constants'
import { logger, addBadgeMessage, getModuleOptions } from './utils'
import { getConfiguration, Options } from './options'

const laravelModule: Module<Options> = function (overwrites) {
  const config = getConfiguration(this.options, overwrites)

  /** GLOBAL CONTEXT **/

  /* Validation */

  // Fail with a warning if we are not in 'spa' mode
  if (this.options.mode !== 'spa') {
    logger.warn(`nuxt-laravel currently only supports 'spa' mode`)

    addBadgeMessage(this.options, false)

    return
  }

  // Fail with error if laravelRoot is invalid
  if (!fs.existsSync(path.join(config.laravel.root, 'artisan'))) {
    logger.error(
      `Unable to find 'artisan' executable in Laravel path: ${config.laravel.root}`
    )

    addBadgeMessage(this.options, false)

    return
  }

  // Fail with error if publicDir cannot be found
  if (!fs.existsSync(config.laravel.public)) {
    logger.error(`Unable to find Laravel public dir: ${config.laravel.public}`)

    addBadgeMessage(this.options, false)

    return
  }

  /* Implementation */

  // Optional cache module
  if (config.cache) {
    const pwa = getModuleOptions(this.options, '@nuxtjs/pwa')
    const routingExtensions =
      (pwa && pwa.workbox && pwa.workbox.routingExtensions) || []

    const { dst } = this.addTemplate({
      src: path.join(__dirname, 'templates', 'workbox.cache.ejs'),
      options: config.cache,
      fileName: config.cache.fileName,
    })

    this.options.pwa = {
      ...pwa,
      workbox: {
        ...(pwa && pwa.workbox),
        routingExtensions: [
          ...(typeof routingExtensions === 'string'
            ? [routingExtensions]
            : routingExtensions),
          path.join(this.options.buildDir!, dst),
        ],
      },
    }

    this.requireModule('@nuxtjs/pwa')
  }

  /** DEV behavior **/
  if (this.options.dev) {
    /* Validation */

    // Fail with warning if server is not configured
    if (!config.laravel.server) {
      logger.warn('Laravel test server is disabled')

      addBadgeMessage(this.options, false)

      return
    }

    // Fail with error if nuxt dev server is not configured
    if (!this.options.server) {
      logger.warn('Nuxt dev server is disabled')

      addBadgeMessage(this.options, false)

      return
    }

    /* Implementation */

    // resolve pertinent config parameters
    const laravelUrl = new URL(
      `http://${config.laravel.server.host || 'localhost'}:${
        config.laravel.server.port
      }`
    )

    this.options.axios = {
      ...(this.options.axios || {}),
      proxy: true,
    }
    this.options.proxy = [
      ...(this.options.proxy || []),
      [
        [
          '**',
          `!${config.nuxt.urlPath}`,
          `!${path.posix.join(config.routerBase, '_loading')}/**`,
        ],
        {
          target: laravelUrl.origin,
          ws: false,
          logLevel: 'debug',
        },
      ],
    ]

    // configure proxy
    this.requireModule('@nuxtjs/axios')

    // extend routes to provide an endpoint for Laravel
    this.extendRoutes((routes: NuxtRouteConfig[]) => {
      let index = routes.find(
        // First, check if there is an unnamed route
        // Then, check if there's a route at /
        // Finally, check for a name with first segment index
        (route) =>
          route.name === '' ||
          route.path === '/' ||
          !!(route.name && route.name.match(/^index(-\w+)?$/))
      )

      // If we were unable to resolve the index route,
      // but modules are present
      if (!index && this.options.modules) {
        const i18nOptions = getModuleOptions(this.options, 'nuxt-i18n')

        // if i18n module is present, we try to find the translated index route
        if (i18nOptions && i18nOptions.defaultLocale) {
          const separator = i18nOptions.routesNameSeparator || '___'
          index = routes.find(
            (route) =>
              !!(
                route.name &&
                route.name.match(
                  new RegExp(`^index${separator}${i18nOptions.defaultLocale}`)
                )
              )
          )
        }
      }

      // Fail with error if index route cannot be resolved
      if (!index) {
        logger.error('Unable to resolve index route')

        addBadgeMessage(this.options, false)

        return
      }

      // add a copy of the index route
      // on the specified render path
      routes.push({
        ...index,
        name: moduleKey,
        path: config.nuxt.routerPath,
      })
    })

    // start Laravel test server on render:before
    let _serverInitialized = false
    this.nuxt.hook(
      'render:before',
      async ({ options }: { options: Configuration }) => {
        /* istanbul ignore next */
        if (_serverInitialized) {
          return
        }
        _serverInitialized = true

        const nuxtServer = options.server!

        if (
          fs.existsSync(config.output.dest) &&
          config.output.dest.replace(config.laravel.public, '').length > 1
        ) {
          logger.warn(
            `Removing production build from: ${config.output.dest}
            to avoid conflicts with dev server`
          )
          fs.removeSync(config.output.dest)
        }

        const nuxtHost = ['0.0.0.0', '127.0.0.1'].includes(`${nuxtServer.host}`)
          ? 'localhost'
          : nuxtServer.host

        // retrieve dev server URL
        const nuxtUrl = new URL(
          config.nuxt.urlPath,
          `http${!!nuxtServer.https ? 's' : ''}://${nuxtHost}:${
            nuxtServer.port
          }`
        )

        // try to start artisan server from Laravel path
        logger.debug(`Nuxt url: ${nuxtUrl.href}`)
        logger.debug(`Laravel url: ${laravelUrl.href}`)

        try {
          const server = execa({stdout: 'inherit', stderr: 'inherit', env: {
              ...process.env,
              [laravelAppEnv]: nuxtUrl.origin,
              [nuxtOutputEnv]: nuxtUrl.href,
            }})`php artisan serve --host=${laravelUrl.hostname === 'localhost' ? '127.0.0.1' : laravelUrl.hostname} --port=${laravelUrl.port}`

          /* istanbul ignore next */
          server.on('error', () => {
            logger.error(`Laravel server failed`)

            if (server && !server.killed) {
              server.kill('SIGKILL')
            }
          })
        } catch (error) {
          logger.error(`Failed to start Laravel server`)

          addBadgeMessage(options, false)

          return
        }

        addBadgeMessage(options)
      }
    )

    return
  }

  // PROD behavior
  // configure generation
  this.options.generate = {
    ...this.options.generate,
    dir: config.output.src,
    exclude: [/.*/],
    fallback: config.output.fallback,
  }

  this.nuxt.hook('generate:done', async ({ nuxt }: { nuxt: any }) => {
    // generate assets
    logger.info('Generating SPA assets...')

    if (config.output.dest.replace(config.laravel.public, '').length > 1) {
      fs.ensureDirSync(config.output.dest)
      fs.moveSync(config.output.src, config.output.dest, { overwrite: true })
    } else {
      fs.copySync(config.output.src, config.output.dest)
      fs.removeSync(config.output.src)
    }

    logger.success(`SPA assets generated in: ${config.output.dest}`)

    const defaultOutput = path.join(config.output.dest, config.output.fallback)

    if (config.output.additional) {
      if (defaultOutput === config.output.additional) {
        logger.info(
          'Skipping index file output, because output path corresponds to default location'
        )
      } else {
        const indexPath = config.output.additional

        // render index route
        logger.info('Rendering additional output file...')

        try {
          const { html, error } = await nuxt.server.renderRoute('/')

          /* istanbul ignore if */
          if (error) {
            throw error
          }

          fs.ensureDirSync(path.dirname(indexPath))
          fs.writeFileSync(indexPath, html, 'utf-8')

          logger.success(`SPA index file rendered to: ${indexPath}`)
        } catch (error) {
          logger.error('Failed to render index route:', error)

          return
        }
      }
    }

    // write to .env file
    if (config.options.dotEnvExport) {
      const envPath = path.join(config.laravel.root, '.env')

      if (fs.existsSync(envPath)) {
        const indexPath = config.output.additional || defaultOutput

        const envInput = fs.readFileSync(envPath).toString()
        const envOutputPrefix = `${EOL}# Added by 'nuxt-laravel' module${EOL}${nuxtOutputEnv}`
        const envOutput = `${envOutputPrefix}=${indexPath}`

        fs.writeFileSync(
          envPath,
          envInput.includes(envOutputPrefix)
            ? envInput.replace(new RegExp(`${envOutputPrefix}.*`), envOutput)
            : envInput.includes(nuxtOutputEnv)
            ? envInput.replace(new RegExp(`${nuxtOutputEnv}.*`), envOutput)
            : envInput.concat(envOutput)
        )
      }
    }
  })

  logger.info('Generation configured for Laravel SPA.')
}

declare module '@nuxt/types' {
  interface Configuration {
    laravel?: Options
  }
}

export { Options, moduleKey, laravelAppEnv, nuxtOutputEnv }
export default laravelModule
export const meta = require('../package.json')
