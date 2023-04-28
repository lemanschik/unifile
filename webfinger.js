(global => {
  // URI to property name map
  const LINK_URI_MAPS = {
    'http://webfist.org/spec/rel': 'webfist',
    'http://webfinger.net/rel/avatar': 'avatar',
    'remotestorage': 'remotestorage',
    'http://tools.ietf.org/id/draft-dejong-remotestorage': 'remotestorage',
    'remoteStorage': 'remotestorage',
    'http://www.packetizer.com/rel/share': 'share',
    'http://webfinger.net/rel/profile-page': 'profile',
    'me': 'profile',
    'vcard': 'vcard',
    'blog': 'blog',
    'http://packetizer.com/rel/blog': 'blog',
    'http://schemas.google.com/g/2010#updates-from': 'updates',
    'https://camlistore.org/rel/server': 'camilstore'
  };

  const LINK_PROPERTIES = {
    'avatar': [],
    'remotestorage': [],
    'blog': [],
    'vcard': [],
    'updates': [],
    'share': [],
    'profile': [],
    'webfist': [],
    'camlistore': []
  };

  // list of endpoints to try, fallback from beginning to end.
  const URIS = ['webfinger', 'host-meta', 'host-meta.json'];

  function generateErrorObject(obj) {
    obj.toString = function () {
      return this.message;
    };
    return obj;
  }

  // given a URL ensures it's HTTPS.
  // returns false for null string or non-HTTPS URL.
  function isSecure(url) {
    if (typeof url !== 'string') {
      return false;
    }
    const parts = url.split('://');
    if (parts[0] === 'https') {
      return true;
    }
    return false;
  }

  /**
   * Function: WebFinger
   *
   * WebFinger constructor
   *
   * Returns:
   *
   *   return WebFinger object
   */
  class WebFinger {
    constructor(config) {
      if (typeof config !== 'object') {
        config = {};
      }

      this.config = {
        tls_only:         (typeof config.tls_only !== 'undefined') ? config.tls_only : true,
        webfist_fallback: (typeof config.webfist_fallback !== 'undefined') ? config.webfist_fallback : false,
        uri_fallback:     (typeof config.uri_fallback !== 'undefined') ? config.uri_fallback : false,
        request_timeout:  (typeof config.request_timeout !== 'undefined') ? config.request_timeout : 10000
      };
    }

    // make an http request and look for JRD response, fails if request fails
    // or response not json.
    __fetchJRD(url, errorHandler, successHandler) {
      if (typeof fetch === 'function') {
          return this.__fetchJRD_fetch(url, errorHandler, successHandler);
      } else if (typeof XMLHttpRequest === 'function') {
        return this.__fetchJRD_XHR(url, errorHandler, successHandler);
      } else {
        throw new Error("add a polyfill for fetch or XMLHttpRequest");
      }
    }

    __fetchJRD_fetch(url, errorHandler, successHandler) {
      const webfinger = this;
      let abortController;
      if (typeof AbortController === 'function') {
        abortController = new AbortController();
      }
      const networkPromise = fetch(url, {
        headers: {'Accept': 'application/jrd+json, application/json'},
        signal: abortController ? abortController.signal : undefined
      }).
      then(response => {
        if (response.ok) {
          return response.text();
        } else if (response.status === 404) {
          throw generateErrorObject({
            message: 'resource not found',
            url,
            status: response.status
          });
        } else {   // other HTTP status (redirects are handled transparently)
          throw generateErrorObject({
            message: 'error during request',
            url,
            status: response.status
          });
        }
      },
      err => {   // connection refused, etc.
        throw generateErrorObject({
          message: 'error during request',
          url,
          status: undefined,
          err
        })
      }).
      then(responseText => {
        if (webfinger.__isValidJSON(responseText)) {
          return responseText;
        } else {
          throw generateErrorObject({
            message: 'invalid json',
            url,
            status: undefined
          });
        }
      });

      const timeoutPromise = new Promise((resolve, reject) => {
        setTimeout(() => {
          reject(generateErrorObject({
            message: 'request timed out',
            url,
            status: undefined
          }));
          if (abortController) {
            abortController.abort();
          }
        }, webfinger.config.request_timeout);
      });

      Promise.race([networkPromise, timeoutPromise]).
      then(responseText => {
        successHandler(responseText);
      }).catch(err => {
        errorHandler(err);
      });
    }

    __fetchJRD_XHR(url, errorHandler, successHandler) {
      const self = this;
      let handlerSpent = false;
      const xhr = new XMLHttpRequest();

      function __processState() {
        if (handlerSpent){
          return;
        }else{
          handlerSpent = true;
        }

        if (xhr.status === 200) {
          if (self.__isValidJSON(xhr.responseText)) {
            return successHandler(xhr.responseText);
          } else {
            return errorHandler(generateErrorObject({
              message: 'invalid json',
              url,
              status: xhr.status
            }));
          }
        } else if (xhr.status === 404) {
          return errorHandler(generateErrorObject({
            message: 'resource not found',
            url,
            status: xhr.status
          }));
        } else if ((xhr.status >= 301) && (xhr.status <= 302)) {
          const location = xhr.getResponseHeader('Location');
          if (isSecure(location)) {
            return __makeRequest(location); // follow redirect
          } else {
            return errorHandler(generateErrorObject({
              message: 'no redirect URL found',
              url,
              status: xhr.status
            }));
          }
        } else {
          return errorHandler(generateErrorObject({
            message: 'error during request',
            url,
            status: xhr.status
          }));
        }
      }

      function __makeRequest() {
        xhr.onreadystatechange = () => {
          if (xhr.readyState === 4) {
            __processState();
          }
        };

        xhr.onload = () => {
          __processState();
        };

        xhr.ontimeout = () => errorHandler(generateErrorObject({
          message: 'request timed out',
          url,
          status: xhr.status
        }));

        xhr.open('GET', url, true);
        xhr.timeout = self.config.request_timeout;
        xhr.setRequestHeader('Accept', 'application/jrd+json, application/json');
        xhr.send();
      }

      return __makeRequest();
    }

    __isValidJSON(str) {
      try {
        JSON.parse(str);
      } catch (e) {
        return false;
      }
      return true;
    }

    __isLocalhost(host) {
      const local = /^localhost(\.localdomain)?(\:[0-9]+)?$/;
      return local.test(host);
    }

    // processes JRD object as if it's a webfinger response object
    // looks for known properties and adds them to profile datat struct.
    __processJRD(URL, JRD, errorHandler, successHandler) {
      const parsedJRD = JSON.parse(JRD);
      if ((typeof parsedJRD !== 'object') ||
          (typeof parsedJRD.links !== 'object')) {
        if (typeof parsedJRD.error !== 'undefined') {
          return errorHandler(generateErrorObject({ message: parsedJRD.error, request: URL }));
        } else {
          return errorHandler(generateErrorObject({ message: 'unknown response from server', request: URL }));
        }
      }

      let links = parsedJRD.links;
      if (!Array.isArray(links)) {
        links = [];
      }
      const result = {  // webfinger JRD - object, json, and our own indexing
        object: parsedJRD,
        json: JRD,
        idx: {}
      };

      result.idx.properties = {
        'name': undefined
      };
      result.idx.links = JSON.parse(JSON.stringify(LINK_PROPERTIES));

      // process links
      links.map((link, i) => {
        if (LINK_URI_MAPS.hasOwnProperty(link.rel)) {
          if (result.idx.links[LINK_URI_MAPS[link.rel]]) {
            const entry = {};
            Object.keys(link).map((item, n) => {
              entry[item] = link[item];
            });
            result.idx.links[LINK_URI_MAPS[link.rel]].push(entry);
          }
        }
      });

      // process properties
      const props = JSON.parse(JRD).properties;
      for (const key in props) {
        if (props.hasOwnProperty(key)) {
          if (key === 'http://packetizer.com/ns/name') {
            result.idx.properties.name = props[key];
          }
        }
      }
      return successHandler(result);
    }

    lookup(address, cb) {
      if (typeof address !== 'string') {
        throw new Error('first parameter must be a user address');
      } else if (typeof cb !== 'function') {
        throw new Error('second parameter must be a callback');
      }

      const self = this;
      let host = '';
      if (address.includes('://')) {
        // other uri format
        host = address.replace(/ /g,'').split('/')[2];
      } else {
        // useraddress
        host = address.replace(/ /g,'').split('@')[1];
      }
      let uri_index = 0;      // track which URIS we've tried already
      let protocol = 'https'; // we use https by default

      if (self.__isLocalhost(host)) {
        protocol = 'http';
      }

      function __buildURL() {
        let uri = '';
        if (! address.split('://')[1]) {
          // the URI has not been defined, default to acct
          uri = 'acct:';
        }
        return `${protocol}://${host}/.well-known/${URIS[uri_index]}?resource=${uri}${address}`;
      }

      // control flow for failures, what to do in various cases, etc.
      function __fallbackChecks(err) {
        if ((self.config.uri_fallback) && (host !== 'webfist.org') && (uri_index !== URIS.length - 1)) { // we have uris left to try
          uri_index = uri_index + 1;
          return __call();
        } else if ((!self.config.tls_only) && (protocol === 'https')) { // try normal http
          uri_index = 0;
          protocol = 'http';
          return __call();
        } else if ((self.config.webfist_fallback) && (host !== 'webfist.org')) { // webfist attempt
          uri_index = 0;
          protocol = 'http';
          host = 'webfist.org';
          // webfist will
          // 1. make a query to the webfist server for the users account
          // 2. from the response, get a link to the actual webfinger json data
          //    (stored somewhere in control of the user)
          // 3. make a request to that url and get the json
          // 4. process it like a normal webfinger response
          const URL = __buildURL();
          self.__fetchJRD(URL, cb, data => { // get link to users JRD
            self.__processJRD(URL, data, cb, ({idx}) => {
              if ((typeof idx.links.webfist === 'object') &&
                  (typeof idx.links.webfist[0].href === 'string')) {
                self.__fetchJRD(idx.links.webfist[0].href, cb, JRD => {
                  self.__processJRD(URL, JRD, cb, result => cb(null, cb));
                });
              }
            });
          });
        } else {
          return cb(err);
        }
      }

      function __call() {
        // make request
        const URL = __buildURL();
        self.__fetchJRD(URL, __fallbackChecks, JRD => {
          self.__processJRD(URL, JRD, cb, result => { cb(null, result); });
        });
      }

      return setTimeout(__call, 0);
    }

    lookupLink(address, rel, cb) {
      if (LINK_PROPERTIES.hasOwnProperty(rel)) {
        this.lookup(address, (err, {idx}) => {
          const links  = idx.links[rel];
          if (err) {
            return cb(err);
          } else if (links.length === 0) {
            return cb(`no links found with rel="${rel}"`);
          } else {
            return cb(null, links[0]);
          }
        });
      } else {
        return cb(`unsupported rel ${rel}`);
      }
    }
  }



  // AMD support
  if (typeof define === 'function' && define.amd) {
      define([], () => WebFinger);
  // CommonJS and Node.js module support.
  } else if (typeof exports !== 'undefined') {
    // Support Node.js specific `module.exports` (which can be a function)
    if (typeof module !== 'undefined' && module.exports) {
        exports = module.exports = WebFinger;
    }
    // But always support CommonJS module 1.1.1 spec (`exports` cannot be a function)
    exports.WebFinger = WebFinger;
  } else {
    // browser <script> support
    global.WebFinger = WebFinger;
  }
})(this);
