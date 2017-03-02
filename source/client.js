/* global window, fetch */
/* eslint no-labels: ['error', { 'allowLoop': true }] */
require('isomorphic-fetch')

import Auth from './auth'
import * as common from './common'

import * as textEncodingPolyfill from 'text-encoding-utf-8' // TextEncoder polyfill

export const ErrAuthProviderNotFound = 'AuthProviderNotFound'
export const ErrInvalidSession = 'InvalidSession'

var EJSON = require('mongodb-extjson')

let TextDecoder = textEncodingPolyfill.TextDecoder
if (typeof (window) !== 'undefined' && (window.TextEncoder !== undefined && window.TextDecoder !== undefined)) {
  TextDecoder = window.TextDecoder
}

const toQueryString = (obj) => {
  var parts = []
  for (var i in obj) {
    if (obj.hasOwnProperty(i)) {
      parts.push(encodeURIComponent(i) + '=' + encodeURIComponent(obj[i]))
    }
  }
  return parts.join('&')
}

export class BaasClient {
  constructor (clientAppID, options) {
    let baseUrl = common.DEFAULT_BAAS_SERVER_URL
    if (options && options.baseUrl) {
      baseUrl = options.baseUrl
    }
    this.appUrl = `${baseUrl}/admin/v1`
    this.authUrl = `${baseUrl}/admin/v1/auth`
    if (clientAppID) {
      this.appUrl = `${baseUrl}/v1/app/${clientAppID}`
      this.authUrl = `${this.appUrl}/auth`
    }
    this.authManager = new Auth(this.authUrl)
    this.authManager.handleRedirect()
  }

  authWithOAuth (providerName, redirectUrl) {
    window.location.replace(this.authManager.getOAuthLoginURL(providerName, redirectUrl))
  }

  authedId () {
    return this.authManager.authedId()
  }

  auth () {
    return this.authManager.get()
  }

  authError () {
    return this.authManager.error()
  }

  logout () {
    return this._doAuthed('/auth', 'DELETE', {refreshOnFailure: false, useRefreshToken: true})
      .then((data) => {
        this.authManager.clear()
      })
  }

  // wrapper around fetch() that matches the signature of doAuthed but does not
  // actually use any auth. This is necessary for routes that must be
  // accessible without logging in, like listing available auth providers.
  _do (resource, method, options) {
    options = options || {}
    let url = `${this.appUrl}${resource}`
    let init = {
      method: method,
      headers: { 'Accept': common.JSONTYPE, 'Content-Type': common.JSONTYPE }
    }
    if (options.body) {
      init['body'] = options.body
    }
    if (options.queryParams) {
      url = url + '?' + toQueryString(options.queryParams)
    }

    return fetch(url, init)
      .then((response) => {
        // Okay: passthrough
        if (response.status >= 200 && response.status < 300) {
          return Promise.resolve(response)
        } else if (response.headers.get('Content-Type') === common.JSONTYPE) {
          return response.json().then((json) => {
            let error = new common.BaasError(json['error'], json['errorCode'])
            error.response = response
            throw error
          })
        }
        let error = new Error(response.statusText)
        error.response = response
        throw error
      }).then((response) => {
        return response.json()
      })
  }

  _doAuthed (resource, method, options) {
    if (options === undefined) {
      options = {refreshOnFailure: true, useRefreshToken: false}
    } else {
      if (options.refreshOnFailure === undefined) {
        options.refreshOnFailure = true
      }
      if (options.useRefreshToken === undefined) {
        options.useRefreshToken = false
      }
    }

    if (this.auth() === null) {
      return Promise.reject(new common.BaasError('Must auth first'))
    }

    let url = `${this.appUrl}${resource}`

    let headers = {
      'Accept': common.JSONTYPE,
      'Content-Type': common.JSONTYPE
    }
    let token = options.useRefreshToken ? this.authManager.getRefreshToken() : this.auth()['accessToken']
    headers['Authorization'] = `Bearer ${token}`

    let init = {
      method: method,
      headers: headers
    }

    if (options.body) {
      init['body'] = options.body
    }

    if (options.queryParams) {
      url = url + '?' + toQueryString(options.queryParams)
    }

    return fetch(url, init).then((response) => {
        // Okay: passthrough
      if (response.status >= 200 && response.status < 300) {
        return Promise.resolve(response)
      } else if (response.headers.get('Content-Type') === common.JSONTYPE) {
        return response.json().then((json) => {
            // Only want to try refreshing token when there's an invalid session
          if ('errorCode' in json && json['errorCode'] === ErrInvalidSession) {
            if (!options.refreshOnFailure) {
              this.authManager.clear()
              let error = new common.BaasError(json['error'], json['errorCode'])
              error.response = response
              throw error
            }

            return this._refreshToken().then(() => {
              options.refreshOnFailure = false
              return this._doAuthed(resource, method, options)
            })
          }

          let error = new common.BaasError(json['error'], json['errorCode'])
          error.response = response
          throw error
        })
      }

      let error = new Error(response.statusText)
      error.response = response
      throw error
    })
  }

  _refreshToken () {
    if (this.authManager.isImpersonatingUser()) {
      return this.authManager.refreshImpersonation(this)
    }
    return this._doAuthed('/auth/newAccessToken', 'POST', {refreshOnFailure: false, useRefreshToken: true}).then((response) => {
      return response.json().then((json) => {
        this.authManager.setAccessToken(json['accessToken'])
        return Promise.resolve()
      })
    })
  }

  executePipeline (stages, options) {
    let responseDecoder = (d) => (new EJSON()).parse(d, {strict: false})
    let responseEncoder = (d) => (new EJSON()).stringify(d)
    if (options) {
      if (options.decoder) {
        if ((typeof options.decoder) !== 'function') {
          throw new Error('decoder option must be a function, but "' + typeof (options.decoder) + '" was provided')
        }
        responseDecoder = options.decoder
      }
      if (options.encoder) {
        if ((typeof options.encoder) !== 'function') {
          throw new Error('encoder option must be a function, but "' + typeof (options.encoder) + '" was provided')
        }
        responseEncoder = options.encoder
      }
    }
    return this._doAuthed('/pipeline', 'POST', {body: responseEncoder(stages)})
      .then(response => {
        if (response.arrayBuffer) {
          return response.arrayBuffer()
        }
        return response.buffer()
      })
      .then(buf => new TextDecoder('utf-8').decode(buf))
      .then(body => responseDecoder(body))
  }
}

class DB {
  constructor (client, service, name) {
    this.client = client
    this.service = service
    this.name = name
  }

  getCollection (name) {
    return new Collection(this, name)
  }
}

class Collection {
  constructor (db, name) {
    this.db = db
    this.name = name
  }

  getBaseArgs () {
    return {
      'database': this.db.name,
      'collection': this.name
    }
  }

  deleteOne (query) {
    let args = this.getBaseArgs()
    args.query = query
    args.singleDoc = true
    return this.db.client.executePipeline([
      {
        'service': this.db.service,
        'action': 'delete',
        'args': args
      }
    ])
  }

  deleteMany (query) {
    let args = this.getBaseArgs()
    args.query = query
    args.singleDoc = false
    return this.db.client.executePipeline([
      {
        'service': this.db.service,
        'action': 'delete',
        'args': args
      }
    ])
  }

  find (query, project) {
    let args = this.getBaseArgs()
    args.query = query
    args.project = project
    return this.db.client.executePipeline([
      {
        'service': this.db.service,
        'action': 'find',
        'args': args
      }
    ])
  }

  insert (docs) {
    let toInsert
    if (docs instanceof Array) {
      toInsert = docs
    } else {
      toInsert = Array.from(arguments)
    }

    return this.db.client.executePipeline([
      {'action': 'literal',
        'args': {
          'items': toInsert
        }
      },
      {
        'service': this.db.service,
        'action': 'insert',
        'args': this.getBaseArgs()
      }
    ])
  }

  makeUpdateStage (query, update, upsert, multi) {
    let args = this.getBaseArgs()
    args.query = query
    args.update = update
    if (upsert) {
      args.upsert = true
    }
    if (multi) {
      args.multi = true
    }

    return {
      'service': this.db.service,
      'action': 'update',
      'args': args
    }
  }

  updateOne (query, update) {
    return this.db.client.executePipeline([this.makeUpdateStage(query, update, false, false)])
  }

  updateMany (query, update, upsert, multi) {
    return this.db.client.executePipeline([this.makeUpdateStage(query, update, false, true)])
  }

  upsert (query, update) {
    return this.db.client.executePipeline([this.makeUpdateStage(query, update, true, false)])
  }

}

export class MongoClient {

  constructor (baasClient, serviceName) {
    this.baasClient = baasClient
    this.service = serviceName
  }

  getDb (name) {
    return new DB(this.baasClient, this.service, name)
  }

}

export class Admin {

  constructor (baseUrl) {
    this.client = new BaasClient('', {baseUrl})
  }

  _doAuthed (url, method, options) {
    return this.client._doAuthed(url, method, options)
      .then((response) => {
        return response.json()
      })
  }

  _get (url, queryParams) {
    return this._doAuthed(url, 'GET', {queryParams})
  }

  _put (url, queryParams) {
    return this._doAuthed(url, 'PUT', {queryParams})
  }

  _delete (url) {
    return this._doAuthed(url, 'DELETE')
  }

  _post (url, body) {
    return this._doAuthed(url, 'POST', {body: JSON.stringify(body)})
  }

  profile () {
    let root = this
    return {
      keys: () => ({
        list: () => root._get('/profile/keys'),
        create: (key) => root._post('/profile/keys'),
        apiKey: (keyId) => ({
          get: () => root._get(`/profile/keys/${keyId}`),
          remove: () => this._delete(`/profile/keys/${keyId}`),
          enable: () => root._put(`/profile/keys/${keyId}/enable`),
          disable: () => root._put(`/profile/keys/${keyId}/disable`)
        })
      })
    }
  }

  /* Examples of how to access admin API with this client:
   *
   * List all apps
   *    a.apps().list()
   *
   * Fetch app under name 'planner'
   *    a.apps().app('planner').get()
   *
   * List services under the app 'planner'
   *    a.apps().app('planner').services().list()
   *
   * Delete a rule by ID
   *    a.apps().app('planner').services().service('mdb1').rules().rule('580e6d055b199c221fcb821d').remove()
   *
   */
  apps () {
    let root = this
    return {
      list: () => root._get(`/apps`),
      create: (data) => root._post(`/apps`, data),
      app: (appID) => ({
        get: () => root._get(`/apps/${appID}`),
        remove: () => root._delete(`/apps/${appID}`),

        users: () => ({
          list: (filter) => this._get(`/apps/${appID}/users`, filter),
          user: (uid) => ({
            get: () => this._get(`/apps/${appID}/users/${uid}`),
            logout: () => this._put(`/apps/${appID}/users/${uid}/logout`)
          })
        }),

        sandbox: () => ({
          executePipeline: (data, userId) => {
            return this._doAuthed(
              `/apps/${appID}/sandbox/pipeline`,
              'POST',
              {body: JSON.stringify(data), queryParams: {user_id: userId}})
          }
        }),

        authProviders: () => ({
          create: (data) => this._post(`/apps/${appID}/authProviders`, data),
          list: () => this._get(`/apps/${appID}/authProviders`),
          provider: (authType, authName) => ({
            get: () => this._get(`/apps/${appID}/authProviders/${authType}/${authName}`),
            remove: () => this._delete(`/apps/${appID}/authProviders/${authType}/${authName}`),
            update: (data) => this._post(`/apps/${appID}/authProviders/${authType}/${authName}`, data)
          })
        }),
        variables: () => ({
          list: () => this._get(`/apps/${appID}/vars`),
          variable: (varName) => ({
            get: () => this._get(`/apps/${appID}/vars/${varName}`),
            remove: () => this._delete(`/apps/${appID}/vars/${varName}`),
            create: (data) => this._post(`/apps/${appID}/vars/${varName}`, data),
            update: (data) => this._post(`/apps/${appID}/vars/${varName}`, data)
          })
        }),
        logs: () => ({
          get: (filter) => this._get(`/apps/${appID}/logs`, filter)
        }),
        apiKeys: () => ({
          list: () => this._get(`/apps/${appID}/keys`),
          create: (data) => this._post(`/apps/${appID}/keys`, data),
          apiKey: (key) => ({
            get: () => this._get(`/apps/${appID}/keys/${key}`),
            remove: () => this._delete(`/apps/${appID}/keys/${key}`),
            enable: () => this._put(`/apps/${appID}/keys/${key}/enable`),
            disable: () => this._put(`/apps/${appID}/keys/${key}/disable`)
          })
        }),
        services: () => ({
          list: () => this._get(`/apps/${appID}/services`),
          create: (data) => this._post(`/apps/${appID}/services`, data),
          service: (svc) => ({
            get: () => this._get(`/apps/${appID}/services/${svc}`),
            update: (data) => this._post(`/apps/${appID}/services/${svc}`, data),
            remove: () => this._delete(`/apps/${appID}/services/${svc}`),
            setConfig: (data) => this._post(`/apps/${appID}/services/${svc}/config`, data),

            rules: () => ({
              list: () => this._get(`/apps/${appID}/services/${svc}/rules`),
              create: (data) => this._post(`/apps/${appID}/services/${svc}/rules`),
              rule: (ruleId) => ({
                get: () => this._get(`/apps/${appID}/services/${svc}/rules/${ruleId}`),
                update: (data) => this._post(`/apps/${appID}/services/${svc}/rules/${ruleId}`, data),
                remove: () => this._delete(`/apps/${appID}/services/${svc}/rules/${ruleId}`)
              })
            }),

            triggers: () => ({
              list: () => this._get(`/apps/${appID}/services/${svc}/triggers`),
              create: (data) => this._post(`/apps/${appID}/services/${svc}/triggers`),
              trigger: (triggerId) => ({
                get: () => this._get(`/apps/${appID}/services/${svc}/triggers/${triggerId}`),
                update: (data) => this._post(`/apps/${appID}/services/${svc}/triggers/${triggerId}`, data),
                remove: () => this._delete(`/apps/${appID}/services/${svc}/triggers/${triggerId}`)
              })
            })
          })
        })
      })
    }
  }

  _admin () {
    return {
      logs: () => ({
        get: (filter) => this._doAuthed('/admin/logs', 'GET', {useRefreshToken: true, queryParams: filter})
      }),
      users: () => ({
        list: (filter) => this._doAuthed('/admin/users', 'GET', {useRefreshToken: true, queryParams: filter}),
        user: (uid) => ({
          logout: () => this._doAuthed(`/admin/users/${uid}/logout`, 'PUT', {useRefreshToken: true})
        })
      })
    }
  }

  _isImpersonatingUser () {
    return this.client.authManager.isImpersonatingUser()
  }

  _startImpersonation (userId) {
    return this.client.authManager.startImpersonation(this.client, userId)
  }

  _stopImpersonation (userId) {
    return this.client.authManager.stopImpersonation()
  }
}
