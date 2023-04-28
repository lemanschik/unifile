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

  const fetchJRD = (url, errorHandlerCallback, successHandler, timeout = 1000) => Promise.race([fetch(url, {
      headers: {'Accept': 'application/jrd+json, application/json'}
    }).then(response => {
      if (response.ok) {
        return response.json();
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
    }, err => {   // connection refused, etc.
      throw generateErrorObject({
        message: 'error during request',
        url,
        status: undefined,
        err
      })
    }), new Promise((resolve, reject) => {
      setTimeout(() => {
        reject(generateErrorObject({
          message: 'request timed out',
          url,
          status: undefined
        }));
        if (abortController) {
          abortController.abort();
        }
      }, timeout);
    })]).then(successHandler).catch(errorHandlerCallback);
  

  class WebFinger {
    constructor(config={}) {
      this.config = {
        tls_only:         !!config.tls_only, // true if undefiend only false if explicitly false.
        request_timeout:  config.request_timeout || 10000,
        webfist_fallback: config.webfist_fallback,
        uri_fallback:     config.uri_fallback,
      };
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
    // looks for known properties and adds them.
    lookup(address, errorHandlerCallback) {
      if (typeof address !== 'string') {
        throw new Error('first parameter must be a user address');
      } else if (typeof errorHandlerCallback !== 'function') {
        throw new Error('second parameter must be a callback');
      }

      const host = address.includes('://') ? 
        // other uri format
      address.replace(/ /g,'').split('/')[2] : 
        // useraddress
      address.replace(/ /g,'').split('@')[1];
      
      let uri_index = 0;      // track which URIS we've tried already
      let protocol = this.__isLocalhost(host) ? 'http' : 'https'; // we use https by default
      const __processJRD = (URL, parsedJRD, errorHandlerCallback) => {
        
        if ((typeof parsedJRD !== 'object')) {
          if (parsedJRD.error) {
            return errorHandlerCallback(generateErrorObject({ message: parsedJRD.error, request: URL }));
          } else {
            return errorHandlerCallback(generateErrorObject({ message: 'unknown response from server', request: URL }));
          }
        }
  
        const result = {  // webfinger JRD - object, json, and our own indexing
          object: parsedJRD,
          json: parsedJRD,
          idx: {
            properties: { 'name': undefined, },
            links: {...LINK_PROPERTIES},
          }
        };
  
        // process links
        [].concat(parsedJRD.links).filter(link=>LINK_URI_MAPS.hasOwnProperty(link.rel) && result.idx.links[LINK_URI_MAPS[link.rel]])
        .forEach((link, i) => result.idx.links[LINK_URI_MAPS[link.rel]].push(link));
  
        // process properties
        for (const key in parsedJRD.properties) {
          if (parsedJRD.properties[key] && key === 'http://packetizer.com/ns/name') {
            result.idx.properties.name = parsedJRD.properties[key];
          }
        }
        errorHandlerCallback(null,result);
        return result;
        //return successHandler(result);
      }

      const __call = () => {
        const URL = `${protocol}://${host}/.well-known/${URIS[uri_index]}?resource=${address.indexOf('://') > -1 ? '' : 'acct:'}${address}`;
        fetchJRD(URL, (err) => { // control flow for failures, what to do in various cases, etc.
          if ((this.config.uri_fallback) && (host !== 'webfist.org') && (uri_index !== URIS.length - 1)) { // we have uris left to try
            uri_index = uri_index + 1;
            return __call();
          } else if ((!this.config.tls_only) && (protocol === 'https')) { // try normal http
            uri_index = 0;
            protocol = 'http';
            return __call();
          } else if ((this.config.webfist_fallback) && (host !== 'webfist.org')) { // webfist attempt
            uri_index = 0;
            protocol = 'http';
            host = 'webfist.org';
            // 1. make a query to the webfist server for the users account
            // 2. from the response, get a link to the actual webfinger json data
            //    (stored somewhere in control of the user)
            // 3. make a request to that url and get the json
            // 4. process it like a normal webfinger response
            const URL = `${protocol}://${host}/.well-known/${URIS[uri_index]}?resource=${address.indexOf('://') > -1 ? '' : 'acct:'}${address}`;
            return fetchJRD(URL, errorHandlerCallback, data => { // get link to users JRD
              const idx = this.__processJRD(URL, data, errorHandlerCallback);
              if ((typeof idx.links.webfist === 'object') && (typeof idx.links.webfist[0].href === 'string')) {
                fetchJRD(idx.links.webfist[0].href, errorHandlerCallback, JRD => {
                  this.__processJRD(URL, JRD, errorHandlerCallback)
                },this.config.request_timeout);
              }
            },this.config.request_timeout);
            
          } else {
            errorHandlerCallback(err);
          }
        }, JRD => {
          return this.__processJRD(URL, JRD, errorHandlerCallback);
        },this.config.request_timeout);
      }
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
