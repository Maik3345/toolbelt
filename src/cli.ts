#!/usr/bin/env node
import 'any-promise/register/bluebird'
import * as Bluebird from 'bluebird'
import chalk from 'chalk'
import { all as clearCachedModules } from 'clear-module'
import { CommandNotFoundError, find, MissingRequiredArgsError, run as unboundRun } from 'findhelp'
import * as moment from 'moment'
import * as path from 'path'
import { reject, without } from 'ramda'
import { isFunction } from 'ramda-adjunct'

import * as pkg from '../package.json'
import { getToken } from './conf'
import { CommandError, SSEConnectionError, UserCancelledError } from './errors'
import log from './logger'
import tree from './modules/tree'
import notify from './update'

global.Promise = Bluebird
Bluebird.config({
  cancellation: true,
})

const run = command => Bluebird.resolve(unboundRun.call(tree, command, path.join(__dirname, 'modules')))

const loginCmd = tree.login
let loginPending = false

// Setup logging
const VERBOSE = '--verbose'
const isVerbose = process.argv.indexOf(VERBOSE) >= 0
if (isVerbose) {
  log.level = 'debug'
  ;(log.default.transports.console as any).timestamp = () =>
    chalk.grey(moment().format('HH:mm:ss.SSS'))
}

if (process.env.NODE_ENV === 'development') {
  try {
    require('longjohn') // tslint:disable-line
  } catch (e) {
    log.debug('Couldn\'t require longjohn. If you want long stack traces, run: npm install -g longjohn')
  }
}

// Show update notification if newer version is available
notify()

const logToolbeltVersion = () => {
  log.debug(`Toolbelt version: ${pkg.version}`)
}

const checkLogin = args => {
  const first = args[0]
  const whitelist = [undefined, 'login', 'logout', 'switch', 'whoami', 'init', '-v', '--version']
  if (!getToken() && whitelist.indexOf(first) === -1) {
    log.debug('Requesting login before command:', args.join(' '))
    return run({ command: loginCmd })
  }
}

const main = async () => {
  const args = process.argv.slice(2)

  logToolbeltVersion()

  await checkLogin(args)

  const command = await find(tree, without([VERBOSE], args))

  if (isVerbose) {
    const findWhoami = await find(tree, ['whoami'])
    if (command.command !== findWhoami.command) {
      await run(findWhoami)
    }
  }

  await run(command)
}

const onError = e => {
  const status = e.response && e.response.status
  const statusText = e.response && e.response.statusText
  const data = e.response && e.response.data
  const code = e.code || null

  if (status) {
    if (status === 401) {
      if (!loginPending) {
        log.error('There was an authentication error. Please login again')
        // Try to login and re-issue the command.
        loginPending = true
        return run({ command: loginCmd }).tap(clearCachedModules).then(main) // TODO: catch with different handler for second error
      } else {
        return // Prevent multiple login attempts
      }
    }
    if (status >= 400) {
      const message = data ? data.message : null
      const source = e.config.url
      log.error('API:', status, statusText)
      if (message) {
        log.error('Message:', message)
        if (isVerbose) {
          log.debug('Raw error:', data)
        }
      } else {
        log.error('Raw error:', {
          data,
          source,
        })
      }
    } else {
      log.error('Oops! There was an unexpected error:')
      log.error(e.read ? e.read().toString('utf8') : data)
    }
  } else if (code) {
    switch (code) {
      case 'ENOTFOUND':
        log.error('Connection failure :(')
        log.error('Please check your internet')
        break
      case 'EAI_AGAIN':
        log.error('A temporary failure in name resolution occurred :(')
        break
      default:
        log.error('Something exploded :(')
        if (e.config && e.config.url && e.config.method) {
          log.error(`${e.config.method} ${e.config.url}`)
        }
        if (isVerbose) {
          log.error(reject(isFunction, e))
        }
    }
  } else {
    switch (e.name) {
      case MissingRequiredArgsError.name:
        log.error('Missing required arguments:', chalk.blue(e.message))
        break
      case CommandNotFoundError.name:
        log.error('Command not found:', chalk.blue(...process.argv.slice(2)))
        break
      case CommandError.name:
        if (e.message && e.message !== '') {
          log.error(e.message)
        }
        break
      case SSEConnectionError.name:
        log.error('Connection to login server has failed')
        break
      case UserCancelledError.name:
        log.debug('User Cancelled')
        break
      default:
        log.error('Something went wrong, I don\'t know what to do :(')
        log.error(reject(isFunction, e))
    }
  }

  process.exit(1)
}

try {
  main().catch(onError)
} catch (e) {
  onError(e)
}

process.on('unhandledRejection', onError)
