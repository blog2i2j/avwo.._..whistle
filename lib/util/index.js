var http = require('http');
var path = require('path');
var os = require('os');
var fs = require('fs');
var vm = require('vm');
var net = require('net');
var tls = require('tls');
var crypto = require('crypto');
var fse = require('fs-extra2');
var qs = require('querystring');
var extend = require('extend');
var LRU = require('lru-cache');
var json5 = require('json5');
var iconv = require('iconv-lite');
var zlib = require('zlib');
var dns = require('dns');
var PipeStream = require('pipestream');
var Buffer = require('safe-buffer').Buffer;
var protoMgr = require('../rules/protocols');
var protocols = protoMgr.protocols;
var logger = require('./logger');
var config = require('../config');
var isUtf8 = require('./is-utf8');
var fileMgr = require('./file-mgr');
var httpMgr = require('./http-mgr');
var ReplacePatternTransform = require('./replace-pattern-transform');
var parseQuery = require('./parse-query');
var common = require('./common');
var proc = require('./process');
var parseUrl = require('./parse-url');
var h2Consts = config.enableH2 ? require('http2').constants : {};

var supportsBr = zlib.createBrotliDecompress && zlib.createBrotliCompress;
var toBuffer = fileMgr.toBuffer;
var pendingFiles = {};
var localIpCache = new LRU({ max: 120 });
var CRLF_RE = /\r\n|\r|\n/g;
var LOCALHOST = '127.0.0.1';
var aliasProtocols = protoMgr.aliasProtocols;
var CONTEXT = vm.createContext();
var END_WIDTH_SEP_RE = /[/\\]$/;
var GEN_URL_RE = /^\s*(?:https?:)?\/\/\w[^\s]*\s*$/i;
var CORS_KEY_RE = /^(?:enable|use-credentials|useCredentials|credentials)$/i;
var G_NON_LATIN1_RE = /\s|[^\x00-\xFF]/gu;
var NON_LATIN1_RE = /[^\x00-\xFF]/;
var SCRIPT_START = toBuffer('<script');
var SCRIPT_END = toBuffer('</script>');
var STYLE_START = toBuffer('<style>');
var STYLE_END = toBuffer('</style>');
var PROXY_RE = /^x?(?:socks|https?-proxy|proxy|internal(?:-https)?-proxy)$/;
var SEP_RE = /[|&]/;
var ctxTimer;
var END_RE = /[/\\]$/;
var EXPIRED_SEC = -123456;
var EXP_COOKIE = { maxAge: EXPIRED_SEC, path: '/' };
var EXP_SECURE_COOKIE = { maxAge: EXPIRED_SEC, path: '/', secure: true };
var EXP_COOKIE_D = { maxAge: EXPIRED_SEC, path: '/' };
var EXP_SECURE_COOKIE_D = { maxAge: EXPIRED_SEC, path: '/', secure: true };
var resetContext = function () {
  ctxTimer = null;
  CONTEXT = vm.createContext();
};
var TIMEOUT_ERR = new Error('Timeout');
var SUB_MATCH_RE = /\$[&\d]/;
var PROTO_NAME_RE = /^([\w.-]+):\/\//;
var replacePattern = ReplacePatternTransform.replacePattern;
var CIPHER_OPTIONS = [
  'NULL-SHA256',
  'AES128-SHA256',
  'AES256-SHA256',
  'AES128-GCM-SHA256',
  'AES256-GCM-SHA384',
  'DH-RSA-AES128-SHA256',
  'DH-RSA-AES256-SHA256',
  'DH-RSA-AES128-GCM-SHA256',
  'DH-RSA-AES256-GCM-SHA384',
  'DH-DSS-AES128-SHA256',
  'DH-DSS-AES256-SHA256',
  'DH-DSS-AES128-GCM-SHA256',
  'DH-DSS-AES256-GCM-SHA384',
  'DHE-RSA-AES128-SHA256',
  'DHE-RSA-AES256-SHA256',
  'DHE-RSA-AES128-GCM-SHA256',
  'DHE-RSA-AES256-GCM-SHA384',
  'DHE-DSS-AES128-SHA256',
  'DHE-DSS-AES256-SHA256',
  'DHE-DSS-AES128-GCM-SHA256',
  'DHE-DSS-AES256-GCM-SHA384',
  'ECDHE-RSA-AES128-SHA256',
  'ECDHE-RSA-AES256-SHA384',
  'ECDHE-RSA-AES128-GCM-SHA256',
  'ECDHE-RSA-AES256-GCM-SHA384',
  'ECDHE-ECDSA-AES128-SHA256',
  'ECDHE-ECDSA-AES256-SHA384',
  'ECDHE-ECDSA-AES128-GCM-SHA256',
  'ECDHE-ECDSA-AES256-GCM-SHA384',
  'ADH-AES128-SHA256',
  'ADH-AES256-SHA256',
  'ADH-AES128-GCM-SHA256',
  'ADH-AES256-GCM-SHA384',
  'AES128-CCM',
  'AES256-CCM',
  'DHE-RSA-AES128-CCM',
  'DHE-RSA-AES256-CCM',
  'AES128-CCM8',
  'AES256-CCM8',
  'DHE-RSA-AES128-CCM8',
  'DHE-RSA-AES256-CCM8',
  'ECDHE-ECDSA-AES128-CCM',
  'ECDHE-ECDSA-AES256-CCM',
  'ECDHE-ECDSA-AES128-CCM8',
  'ECDHE-ECDSA-AES256-CCM8'
];
var TLSV2_CIPHERS = 'ECDHE-ECDSA-AES256-GCM-SHA384';
var cryptoConsts = crypto.constants || {};
var EMPTY_BUFFER = toBuffer('');
var encodeHtml = common.encodeHtml;
var lowerCaseify = common.lowerCaseify;
var removeIPV6Prefix = common.removeIPV6Prefix;
var hasBody = common.hasBody;
var hasProtocol = common.hasProtocol;
var removeProtocol = common.removeProtocol;
var isUrl = common.isUrl;
var joinIpPort = common.joinIpPort;
var workerIndex = process.env && process.env.workerIndex;
var INTERNAL_ID = process.pid + '-' + Math.random();
var pluginMgr;
var RESOLVE_KEY_RE = /^re[qs]Merge:\/\//;
var CONTROL_RE =
  /[\u001e\u001f\u200e\u200f\u200d\u200c\u202a\u202d\u202e\u202c\u206e\u206f\u206b\u206a\u206d\u206c]+/g;
var MULTI_LINE_VALUE_RE =
  /^[^\n\r\S]*(```+)[^\n\r\S]*(\S+)[^\n\r\S]*[\r\n](?:([\s\S]*?)[\r\n])??[^\n\r\S]*\1\s*$/gm;

workerIndex = workerIndex >= 0 ? padReqId(config.workerIndex) : '';

exports.TIMEOUT_ERR = TIMEOUT_ERR;
exports.encodeHtml = encodeHtml;
exports.hasProtocol = hasProtocol;
exports.removeProtocol = removeProtocol;
exports.setProtocol = common.setProtocol;
exports.getProtocol = common.getProtocol;
exports.replaceProtocol = common.replaceProtocol;
exports.getPureUrl = common.getPureUrl;
exports.isTunnelHost = common.isTunnelHost;
exports.joinIpPort = joinIpPort;
exports.isWebSocket = common.isWebSocket;
exports.wrapRuleValue = common.wrapRuleValue;
exports.createTransform = common.createTransform;
exports.readFileSync = common.readFileTextSync;
exports.isUrl = isUrl;
exports.workerIndex = workerIndex;
exports.proc = proc;
exports.INTERNAL_ID = INTERNAL_ID;
// 避免属性被 stringify ，减少冗余数据传给前端
exports.PLUGIN_VALUES =
  typeof Symbol === 'undefined' ? '_values' : Symbol('_values'); // eslint-disable-line
exports.PLUGIN_MENU_CONFIG =
  typeof Symbol === 'undefined' ? '_menuConfig' : Symbol('_menuConfig'); // eslint-disable-line
exports.PLUGIN_INSPECTOR_CONFIG =
  typeof Symbol === 'undefined'
    ? '_inspectorConfig'
    : Symbol('_inspectorConfig'); // eslint-disable-line
exports.drain = require('./drain');
exports.isWin = process.platform === 'win32';
exports.isUtf8 = isUtf8;
exports.WhistleTransform = require('./whistle-transform');
exports.ReplacePatternTransform = ReplacePatternTransform;
exports.replacePattern = replacePattern;
exports.ReplaceStringTransform = require('./replace-string-transform');
exports.SpeedTransform = require('./speed-transform');
exports.FileWriterTransform = require('./file-writer-transform');
exports.getServer = require('hagent').getServer;
exports.parseUrl = parseUrl;
exports.parseQuery = parseQuery;
exports.localIpCache = localIpCache;
exports.listenerCount = require('./patch').listenerCount;
exports.EMPTY_BUFFER = EMPTY_BUFFER;

var NOT_SUPPORTED_ERR = new Error('Unsupported');
NOT_SUPPORTED_ERR.code = 502;

function request(options, callback) {
  if (options && options.isInternalReq) {
    return callback && callback(NOT_SUPPORTED_ERR, '', '');
  }
  return httpMgr.request(common.setInternalOptions(options, config, true), callback);
}

exports.request = request;

exports.resolveInlineValues = function (str, inlineValues) {
  str = str && str.replace(CONTROL_RE, '').trim();
  if (!str || str.indexOf('```') === -1) {
    return str;
  }
  return str.replace(MULTI_LINE_VALUE_RE, function (_, __, key, value) {
    if (inlineValues[key] == null) {
      inlineValues[key] = value || '';
    }
    return '';
  });
};

function setSecureOptions(options) {
  var secureOptions = cryptoConsts.SSL_OP_ALLOW_UNSAFE_LEGACY_RENEGOTIATION;
  if (secureOptions) {
    options.secureOptions = secureOptions;
  }
  return options;
}

exports.setSecureOptions = setSecureOptions;

function noop(_) {
  return _;
}

exports.noop = noop;

function isCiphersError(e) {
  return (
    e.code === 'EPROTO' ||
    String(e.message).indexOf(
      'disconnected before secure TLS connection was established'
    ) !== -1
  );
}

exports.isCiphersError = isCiphersError;

function getScriptProps(props) {
  var result = '';
  if (props['use-credentials'] || props.useCredentials){
    result += ' crossorigin="use-credentials"';
  } else if (props.anonymous) {
    result += ' crossorigin="anonymous"';
  } else if (props.crossorigin) {
    result += ' crossorigin';
  }
  if (props.defer) {
    result += ' defer';
  }
  if (props.async) {
    result += ' async';
  }
  if (props.nomodule) {
    result += ' nomodule';
  }
  if (props.module) {
    result += ' type="module"';
  } else if (props.importmap) {
    result += ' type="importmap"';
  } else if (props.speculationrules) {
    result += ' type="speculationrules"';
  }
  return result;
}

function wrapJs(js, charset, isUrl, props) {
  if (!js) {
    return '';
  }
  if (isUrl) {
    return toBuffer('<script' + getScriptProps(props) + ' src="' + js + '"></script>', charset);
  }
  return Buffer.concat([SCRIPT_START, toBuffer(getScriptProps(props) + '>'), toBuffer(js, charset), SCRIPT_END]);
}

function wrapCss(css, charset, isUrl) {
  if (!css) {
    return '';
  }
  if (isUrl) {
    return toBuffer('<link rel="stylesheet" href="' + css + '" />', charset);
  }
  return Buffer.concat([STYLE_START, toBuffer(css, charset), STYLE_END]);
}

function evalJson(str) {
  try {
    return json5.parse(str);
  } catch (e) {}
}

exports.parseRawJson = evalJson;

var MAX_LEN = 1024 * 1024 * 5;

function getLatestVersion(registry, cb) {
  if (registry && typeof registry !== 'string') {
    var name = registry.moduleName;
    registry = registry.registry || 'https://registry.npmjs.org';
    registry = registry.replace(/\/$/, '') + '/' + name;
  }
  if (!registry) {
    return cb();
  }
  request(
    {
      url: registry,
      maxLength: MAX_LEN
    },
    function (err, body, res) {
      if (err || res.statusCode !== 200) {
        body = null;
      } else if (body) {
        body = parseJSON(body);
      }
      body = body && body['dist-tags'];
      cb(body && body['latest']);
    }
  );
}

exports.getRegistry = function(pkg) {
  var registry = pkg.whistleConfig && pkg.whistleConfig.registry;
  return common.getRegistry(registry);
};
exports.getLatestVersion = getLatestVersion;
exports.isEmptyObject = common.isEmptyObject;
exports.isGroup = common.isGroup;
exports.addTrailerNames = common.addTrailerNames;
exports.removeIllegalTrailers = common.removeIllegalTrailers;
exports.isHead = common.isHead;
exports.hasBody = hasBody;

var ESTABLISHED_CTN =
  'HTTP/1.1 200 Connection Established\r\nProxy-Agent: ' +
  config.name +
  '\r\n\r\n';
exports.setEstablished = function (socket) {
  socket.write(ESTABLISHED_CTN);
};

var PORT_RE = /:\d*$/;

exports.changePort = function(url, port) {
  var protocol = '';
  var index = url.indexOf('://');
  if (index !== -1) {
    index += 3;
    protocol = url.substring(0, index);
    url = url.substring(index);
  }
  index = url.indexOf('/');
  if (index != -1) {
    var host = url.substring(0, index);
    if (net.isIPv6(host)) {
      host = '[' + host + ']';
    } else {
      host = host.replace(PORT_RE, '');
    }
    url = host + ':' + port + url.substring(index);
  }
  return protocol + url;
};

function handleStatusCode(statusCode, headers) {
  if (statusCode == 401) {
    headers['www-authenticate'] = 'Basic realm=User Login';
  } else if (statusCode == 407) {
    headers['proxy-authenticate'] = 'Basic realm=User Login';
  }
  return headers;
}

exports.handleStatusCode = handleStatusCode;

function getStatusCode(statusCode) {
  statusCode |= 0;
  return statusCode < 100 || statusCode > 999 ? 0 : statusCode;
}

exports.getStatusCode = getStatusCode;

function compare(v1, v2) {
  return v1 == v2 ? 0 : v1 > v2 ? -1 : 1;
}

exports.compare = compare;

var scriptCache = {};
var VM_OPTIONS = {
  displayErrors: false,
  timeout: 60
};
var MAX_SCRIPT_SIZE = 1024 * 256;
var MAX_SCRIPT_CACHE_COUNT = 64;
var MIN_SCRIPT_CACHE_COUNT = 32;

function getScript(content) {
  content = content.trim();
  var len = content.length;
  if (!len || len > MAX_SCRIPT_SIZE) {
    return;
  }

  var script = scriptCache[content];
  delete scriptCache[content];

  var list = Object.keys(scriptCache);
  if (list.length > MAX_SCRIPT_CACHE_COUNT) {
    list = list
      .map(function (content) {
        var script = scriptCache[content];
        script.content = content;
        return script;
      })
      .sort(function (a, b) {
        return compare(a.time, b.time);
      })
      .splice(0, MIN_SCRIPT_CACHE_COUNT);

    scriptCache = {};
    list.forEach(function (script) {
      scriptCache[script.content] = {
        script: script.script,
        time: script.time
      };
    });
  }

  script = scriptCache[content] = script || {
    script: new vm.Script('(function(){\n' + content + '\n})()')
  };
  script.time = Date.now();

  return script.script;
}

function clearContext() {
  Object.keys(CONTEXT).forEach(function (key) {
    delete CONTEXT[key];
  });
  if (!ctxTimer) {
    ctxTimer = setTimeout(resetContext, 30000);
  }
}

exports.execScriptSync = function(script, context) {
  try {
    if ((script = getScript(script))) {
      CONTEXT.console = {};
      ['fatal', 'error', 'warn', 'info', 'log', 'debug'].forEach(function (
        level
      ) {
        CONTEXT.console[level] = logger[level];
      });
      Object.keys(context).forEach(function (key) {
        CONTEXT[key] = context[key];
      });
      script.runInContext(CONTEXT, VM_OPTIONS);
    }
    return true;
  } catch (e) {
    logger.error(e);
  } finally {
    clearContext();
  }
};

function stat(file, callback, force) {
  if (force) {
    return callback(true);
  }
  fs.stat(file, function (err) {
    if (!err || err.code === 'ENOTDIR') {
      return callback();
    }
    if (err.code === 'ENOENT') {
      return callback(true);
    }
    fs.stat(file, callback);
  });
}

function spreadPromise(promise, callback) {
  promise.then(function(list) {
    callback.apply(null, list);
  });
}

function getFileWriter(file, callback, force) {
  if (!file) {
    return callback();
  }
  if (END_RE.test(file)) {
    file = path.join(file, 'index.html');
  }
  if (!force && pendingFiles[file]) {
    return callback();
  }
  var execCb = function (writer) {
    delete pendingFiles[file];
    callback(writer);
  };
  pendingFiles[file] = 1;
  stat(
    file,
    function (notExists) {
      if (!notExists) {
        return execCb();
      }
      fse.ensureFile(file, function (err) {
        if (err) {
          logger.error(err);
          return execCb();
        }
        execCb(fs.createWriteStream(file).on('error', logger.error));
      });
    },
    force
  );
}

function getFileWriters(files, callback, force) {
  if (!Array.isArray(files)) {
    files = [files];
  }

  spreadPromise(Promise.all(
    files.map(function (file) {
      return new Promise(function(resolve) {
        getFileWriter(
          file,
          function (writer) {
            resolve(writer);
          },
          force
        );
      });
    })
  ), callback);
}

exports.getFileWriters = getFileWriters;
exports.toBuffer = toBuffer;

function getErrorStack(err) {
  if (!err) {
    return '';
  }

  var stack;
  try {
    stack = err.stack;
  } catch (e) {}
  stack = stack || err.message || err;
  var result = [
    'From: ' + config.name + '@' + config.version,
    'Node: ' + process.version,
    'Host: ' + hostname,
    'Date: ' + formatDate(),
    stack
  ];
  return result.join('\r\n');
}

exports.getErrorStack = getErrorStack;

function formatDate(now) {
  now = now || new Date();
  return now.toLocaleString();
}

exports.formatDate = formatDate;

var REG_EXP_RE = /^\/(.+)\/(i?u?|ui)$/;

function isRegExp(regExp) {
  return REG_EXP_RE.test(regExp);
}

exports.isRegExp = isRegExp;

var ORIG_REG_EXP = /^\/(.+)\/([igmu]{0,4})$/;

function isOriginalRegExp(regExp) {
  if (!ORIG_REG_EXP.test(regExp) || /[igmu]{2}/.test(regExp.$2)) {
    return false;
  }

  return true;
}
exports.isOriginalRegExp = isOriginalRegExp;

function toOriginalRegExp(regExp) {
  regExp = ORIG_REG_EXP.test(regExp);
  try {
    regExp = regExp && new RegExp(RegExp.$1, RegExp.$2);
  } catch (e) {
    regExp = null;
  }
  return regExp;
}
exports.toOriginalRegExp = toOriginalRegExp;

exports.emitError = function (obj, err) {
  if (obj) {
    obj.once('error', noop);
    obj.emit('error', err || new Error('Unknown'));
  }
};

exports.indexOfList = require('./buf-util').indexOf;

exports.startWithList = function (buf, subBuf, start) {
  var len = subBuf.length;
  if (!len) {
    return false;
  }

  start = start || 0;
  for (var i = 0; i < len; i++) {
    if (buf[i + start] != subBuf[i]) {
      return false;
    }
  }

  return true;
};

exports.endWithList = function (buf, subBuf, end) {
  var subLen = subBuf.length;
  if (!subLen) {
    return false;
  }
  if (!(end >= 0)) {
    end = buf.length - 1;
  }

  for (var i = 0; i < subLen; i++) {
    if (subBuf[subLen - i - 1] != buf[end - i]) {
      return false;
    }
  }

  return true;
};

function isEnable(req, name) {
  return req.enable[name] && !req.disable[name];
}

exports.isEnable = isEnable;

exports.formatUrl = common.formatUrl;

exports.isKeepClientId = function(req, proxyUrl) {
  if (isEnable(req, 'keepClientId')) {
    return true;
  }
  var disable = req.disable;
  if (disable.clientId || disable.clientID) {
    return false;
  }
  var enable = req.enable;
  return enable.clientId || enable.clientID || proxyUrl;
};

exports.getInternalHost = function (req, host) {
  if (isEnable(req, 'useLocalHost')) {
    return 'local.wproxy.org';
  }
  if (host && isEnable(req, 'useSafePort')) {
    var index = host.indexOf(':');
    if (index !== -1) {
      host = host.substring(0, index);
    }
    host += ':8899';
  }
  return host;
};

function isAuthCapture(req) {
  var e = req.enable || '';
  var d = req.disable || '';
  return (
    (e.authCapture || e.authIntercept) && !d.authCapture && !d.authIntercept
  );
}

exports.isAuthCapture = isAuthCapture;

exports.toRegExp = function toRegExp(regExp, ignoreCase) {
  regExp = REG_EXP_RE.test(regExp);
  try {
    regExp = regExp && new RegExp(RegExp.$1, ignoreCase ? 'i' : RegExp.$2);
  } catch (e) {
    regExp = null;
  }
  return regExp;
};

var isString = common.isString;
var getFullUrl = common.getFullUrl;
exports.isString = isString;
exports.getFullUrl = getFullUrl;

function disableCSP(headers) {
  delete headers['content-security-policy'];
  delete headers['content-security-policy-report-only'];
  delete headers['x-content-security-policy'];
  delete headers['x-content-security-policy-report-only'];
  delete headers['x-webkit-csp'];
}

exports.disableCSP = disableCSP;

var interfaces = os.networkInterfaces();
var hostname = os.hostname();
var simpleHostname = '';
var cpus = os.cpus();
var addressList = [];
(function updateSystyemInfo() {
  interfaces = os.networkInterfaces();
  hostname = os.hostname();
  addressList = [];
  for (var i in interfaces) {
    var list = interfaces[i];
    if (Array.isArray(list)) {
      list.forEach(function (info) {
        addressList.push(info.address.toLowerCase());
      });
    }
  }
  setTimeout(updateSystyemInfo, 30000);
})();

if (isString(hostname)) {
  simpleHostname = hostname.replace(/[^\w.-]+/g, '').substring(0, 20);
  simpleHostname = simpleHostname ? simpleHostname + '.' : '';
}

function createHash(str) {
  return crypto.createHash('sha256').update(str).digest('hex');
}

exports.createHash = createHash;

var clientId = [
  hostname,
  os.platform(),
  os.release(),
  os.arch(),
  cpus.length,
  cpus[0] && cpus[0].model,
  config.clientId
];
clientId = config.clientId =
  simpleHostname +
  crypto
    .createHmac('sha256', config.CLIENT_ID_HEADER)
    .update(clientId.join('\r\n'))
    .digest('base64');
config.runtimeId =
  simpleHostname +
  crypto
    .createHmac('sha256', config.CLIENT_ID_HEADER)
    .update(clientId + '\r\n' + Math.random() + '\r\n' + Date.now())
    .digest('base64') +
  '/' +
  config.port;
config.runtimeHeaders = { 'x-whistle-runtime-id': config.runtimeId };
config.pluginHeaders = {
  'x-whistle-runtime-id': config.runtimeId,
  'x-whistle-internal-id': INTERNAL_ID
};
config.pluginHeaders[config.PLUGIN_HOOK_NAME_HEADER] = config.PLUGIN_HOOKS.UI;

exports.setClientId = function (
  headers,
  enable,
  disable,
  clientIp,
  isInternalProxy
) {
  if (disable && (disable.clientId || disable.clientID)) {
    return;
  }
  enable = enable || '';
  if (
    enable.clientId ||
    enable.clientID ||
    isInternalProxy
  ) {
    var id = getClientId(headers);
    if (
      (enable.multiClient || isInternalProxy) &&
      !enable.singleClient &&
      !disable.multiClient
    ) {
      if (headers[config.CLIENT_ID_HEADER]) {
        return;
      }
      if (!isLocalAddress(clientIp)) {
        id += '/' + clientIp;
      }
    }
    headers[config.CLIENT_ID_HEADER] = id;
  }
};

function getClientId(headers) {
  var id = headers[config.CLIENT_ID_HEADER];
  var idKey = config.cidKey;
  if (!idKey || (id && !config.overCidKey)) {
    return id || clientId;
  }
  return headers[idKey] || id || clientId;
}

exports.getClientId = getClientId;

exports.getUpdateUrl = common.getUpdateUrl;

exports.getTunnelKey = function (conf) {
  var tunnelKey = conf.tunnelKey || conf.tunnelKeys;
  if (tunnelKey && typeof tunnelKey === 'string') {
    tunnelKey = tunnelKey.toLowerCase().split(/[:,|]/);
    tunnelKey = tunnelKey.map(trim).filter(noop);
    return tunnelKey.slice(0, 10);
  }
};

function getComposerClientId(headers) {
  var clientId = headers[config.COMPOSER_CLIENT_ID_HEADER];
  if (clientId) {
    delete headers[config.COMPOSER_CLIENT_ID_HEADER];
    return clientId;
  }
}

exports.getComposerClientId = getComposerClientId;

exports.removeClientId = function (headers) {
  delete headers[config.CLIENT_ID_HEADER];
};

function networkInterfaces() {
  return interfaces;
}

function getHostname() {
  return hostname;
}

exports.networkInterfaces = networkInterfaces;
exports.hostname = getHostname;

function getProxyTunnelPath(req, isHttps) {
  var host = req._phost && req._proxyTunnel && req.headers.host;
  if (isString(host)) {
    return host.indexOf(':') !== -1 ? host : host + ':' + (isHttps ? 443 : 80);
  }
}
exports.getProxyTunnelPath = getProxyTunnelPath;

function isLocalAddress(address) {
  if (isLocalIp(address)) {
    return true;
  }
  address = address.toLowerCase();
  if (address[0] === '[') {
    address = address.slice(1, -1);
  }
  if (address == '0:0:0:0:0:0:0:1') {
    return true;
  }
  return localIpCache.get(address) || addressList.indexOf(address) !== -1;
}

exports.isLocalAddress = isLocalAddress;

function isLocalHost(host) {
  return host === 'localhost' || isLocalAddress(host);
}

exports.isLocalHost = isLocalHost;

function parseHost(host) {
  var index;
  if (host[0] === '[') {
    index = host.indexOf(']');
    return [host.substring(1, index), host.substring(index + 2)];
  }
  index = host.indexOf(':');
  if (index === -1 || host.indexOf(':', index + 1) !== -1) {
    return [host, ''];
  }
  return [host.substring(0, index), host.substring(index + 1)];
}

exports.parseHost = parseHost;

/**
 * 解析一些字符时，encodeURIComponent可能会抛异常，对这种字符不做任何处理
 * see: http://stackoverflow.com/questions/16868415/encodeuricomponent-throws-an-exception
 * @param ch
 * @returns
 */
function safeEncodeURIComponent(ch) {
  try {
    return encodeURIComponent(ch);
  } catch (e) {}

  return ch;
}

exports.encodeNonLatin1Char = function (str) {
  if (!isString(str)) {
    return '';
  }
  return str.replace(G_NON_LATIN1_RE, safeEncodeURIComponent);
};

exports.encodeURIComponent = safeEncodeURIComponent;

function compareUrl(url, fullUrl) {
  url = common.getAbsUrl(url, fullUrl);
  if (url === fullUrl) {
    return true;
  }
  try {
    return url === decodeURIComponent(fullUrl);
  } catch (e) {}
}

exports.compareUrl = compareUrl;

function getPath(url, noProtocol) {
  if (url) {
    url = common.getPureUrl(url);
    var index = noProtocol ? -1 : url.indexOf('://');
    url = index > -1 ? url.substring(index + 3) : url;
  }

  return url;
}

exports.getPath = getPath;

function getFilename(url) {
  if (typeof url == 'string' && (url = getPath(url).trim())) {
    var index = url.lastIndexOf('/');
    if (index != -1) {
      url = url.substring(index + 1);
    } else {
      url = null;
    }
  } else {
    url = null;
  }

  return url || 'index.html';
}

exports.getFilename = getFilename;

function disableReqCache(headers) {
  delete headers['if-modified-since'];
  delete headers['if-none-match'];
  delete headers['last-modified'];
  delete headers.etag;

  headers['pragma'] = 'no-cache';
  headers['cache-control'] = 'no-cache';
}

exports.disableReqCache = disableReqCache;

function disableResStore(headers) {
  headers['cache-control'] = 'no-store';
  headers['expires'] = new Date(Date.now() - 60000000).toGMTString();
  headers['pragma'] = 'no-cache';
  delete headers.tag;
}

exports.disableResStore = disableResStore;

function parsePathReplace(urlPath, params) {
  if (!params || !/^(?:ws|http)s?:/.test(urlPath)) {
    return;
  }
  var index = urlPath.indexOf('://');
  if (index == -1) {
    return;
  }
  index = urlPath.indexOf('/', index + 3) + 1;
  if (index <= 0) {
    return;
  }

  var root = urlPath.substring(0, index);
  urlPath = urlPath.substring(index);

  Object.keys(params).forEach(function (pattern) {
    var value = params[pattern];
    value = value == null ? '' : value + '';
    if (isOriginalRegExp(pattern) && (pattern = toOriginalRegExp(pattern))) {
      urlPath = urlPath.replace(pattern, value);
    } else if (pattern) {
      urlPath = urlPath.split(pattern).join(value);
    }
  });
  root += urlPath;
  return root !== urlPath ? root : null;
}

exports.parsePathReplace = parsePathReplace;

function wrapResponse(res) {
  var passThrough = common.createTransform();
  passThrough.statusCode = res.statusCode;
  passThrough.rawHeaderNames = res.rawHeaderNames;
  passThrough.headers = lowerCaseify(res.headers);
  passThrough.headers['x-server'] = config.name;
  res.body != null &&
    passThrough.push(Buffer.isBuffer(res.body) ? res.body : String(res.body));
  passThrough.push(null);
  passThrough.isCustomRes = true;
  return passThrough;
}

exports.wrapResponse = wrapResponse;

function wrapGatewayError(body) {
  return wrapResponse({
    statusCode: 502,
    headers: {
      'content-type': 'text/html; charset=utf8'
    },
    body: body
      ? '<pre>\n' +
        encodeHtml(body) +
        '\n\n\n<a href="javascript:;" onclick="location.reload()"' +
        '>Reload this page</a>\n</pre>'
      : ''
  });
}

exports.wrapGatewayError = wrapGatewayError;

function sendStatusCodeError(cltRes, svrRes) {
  delete svrRes.headers['content-length'];
  cltRes.writeHead(502, svrRes.headers);
  cltRes.src(wrapGatewayError('Invalid status code: ' + svrRes.statusCode));
}
exports.sendStatusCodeError = sendStatusCodeError;
exports.getQueryValue = function (value) {
  if (value && typeof value === 'object') {
    try {
      return JSON.stringify(value);
    } catch (e) {}
  }
  return value || '';
};

function parseInlineJSON(text, isValue) {
  if (!isValue || /\s/.test(text)) {
    return;
  }
  return parseQuery(text, null, null, true);
}

function _parseJSON(data, resolveKeys) {
  if (typeof data === 'object') {
    return data;
  }
  if (!isString(data) || !(data = data.trim())) {
    return null;
  }
  return parsePureJSON(data, true) || common.parsePlainText(data, resolveKeys === true);
}

function parseJSON(data) {
  return _parseJSON(data);
}

function parsePureJSON(data, isValue) {
  return evalJson(data) || parseInlineJSON(data, isValue);
}

exports.parseJSON = parseJSON;

function trim(text) {
  return text && text.trim();
}

exports.trim = trim;
exports.lowerCaseify = lowerCaseify;

function parseHeaders(headers, rawNames) {
  if (typeof headers == 'string') {
    headers = headers.split(CRLF_RE);
  }
  var _headers = {};
  headers.forEach(function (line) {
    var index = line.indexOf(':');
    var value;
    if (index != -1) {
      value = line.substring(index + 1).trim();
      var rawName = line.substring(0, index).trim();
      var name = rawName.toLowerCase();
      var list = _headers[name];
      if (rawNames) {
        rawNames[name] = rawName;
      }
      if (list) {
        if (!Array.isArray(list)) {
          _headers[name] = list = [list];
        }
        list.push(value);
      } else {
        _headers[name] = value;
      }
    }
  });

  return lowerCaseify(_headers);
}

exports.parseHeaders = parseHeaders;

var QUERY_PARAM_RE = /^[^\\/]+=/;


exports.parseRuleJson = function(rules, callback, req) {
  if (!Array.isArray(rules)) {
    rules = [rules];
  }
  spreadPromise(Promise.all(
    rules.map(function (rule) {
      return new Promise(function(resolve) {
        readRuleList(rule, resolve, true, null, null, req);
      });
    })
  ), callback);
};

function getTempFilePath(filePath, rule) {
  var root = rule.root;
  if (!root && common.TEMP_PATH_RE.test(filePath)) {
    rule._suffix = RegExp.$2;
    return path.join(config.TEMP_FILES_PATH, RegExp.$1);
  }
  filePath = decodePath(filePath);
  return root ? join(root, filePath) : filePath;
}

function readRuleValue(rule, callback, checkUrl, needRawData, req) {
  if (!rule) {
    return callback();
  }
  if (rule.value) {
    return callback(removeProtocol(rule.value, true));
  }
  var filePath = getMatcherValue(rule);
  if (checkUrl && GEN_URL_RE.test(filePath)) {
    return callback(filePath);
  }
  var opts = pluginMgr.resolveKey(filePath, rule, req);
  var readFile;
  if (opts) {
    readFile = pluginMgr[needRawData ? 'requestBin' : 'requestText'];
    return readFile(opts, callback);
  }

  readFile = fileMgr[needRawData ? 'readFile' : 'readFileText'];
  filePath = getTempFilePath(filePath, rule);
  readFile(filePath, callback);
}

function isGenUrl(value) {
  return typeof value === 'string' && GEN_URL_RE.test(value);
}

var CORS_RE = /^re[qs]Cors:\/\//;

function isDeep(result) {
  for (var i = 0, len = result.length; i < len; i++) {
    if (result[i] === true) {
      return true;
    }
  }
}

function indexOfQuote(matcher) {
  return matcher[0] === '"' ? matcher.indexOf('"=') : -1;
}

function getMatcherJson(rule, value) {
  var matcher = rule.rawMatcher;
  var eq = matcher.indexOf('=');
  if (eq === -1) {
    return;
  }
  var and = matcher.indexOf('&');
  if (and !== -1 && and > eq) {
    return;
  }
  matcher = removeProtocol(matcher, true);
  var len = matcher.length - 1;
  var first = matcher[0];
  var last = matcher[len];
  if (first === '{' && last === '}') {
    return;
  }
  var index;
  if (first === '(' && last === ')') {
    matcher = matcher.substring(1, len);
  } else {
    if (!QUERY_PARAM_RE.test(matcher)) {
      index = indexOfQuote(matcher);
      if (index === -1) {
        return;
      }
    } else if (first === '<' && last === '>') {
      matcher = matcher.substring(1, len);
    }
  }
  if (index == null) {
    index = indexOfQuote(matcher);
  }
  var hasQuote;
  if (index === -1) {
    index =  matcher.indexOf('=');
  } else {
    index += 1;
    hasQuote = true;
  }
  var key = matcher.substring(0, index);
  value = value || removeProtocol(getMatcher(rule), true);
  if (value.indexOf(key + '=')) {
    return;
  }
  var result = {};
  result[hasQuote ? key.substring(1, index - 1) : key] = value.substring(index + 1);
  return result;
}

function readRuleList(rule, callback, isJson, charset, isHtml, req) {
  if (!rule) {
    return callback();
  }
  var len = rule.list && rule.list.length;
  var isBin = protoMgr.isBinProtocol(rule.name);
  var needRawData = isBin && !isJson;
  if (!len) {
    var json = isJson && getMatcherJson(rule);
    if (json) {
      return callback(json);
    }
    return readRuleValue(
      rule,
      isJson
        ? function (value) {
          callback(_parseJSON(value, RESOLVE_KEY_RE.test(rule.matcher)));
        }
        : callback,
        false,
        needRawData,
        req
    );
  }
  var result = [];
  var isJsHtml = isHtml && isBin === 2;
  var isCssHtml = isHtml && isBin === 3;
  var isRawList = rule.isRawList;
  var execCallback = function () {
    if (--len > 0) {
      return;
    }
    if (isJson) {
      var deepMerge = isDeep(result);
      result = result.map(function(text, i) {
        var item = rule.list[i];
        return _parseJSON(text, item && RESOLVE_KEY_RE.test(item.matcher));
      }).filter(noop);
      if (result.length > 1) {
        result.reverse();
        if (typeof result[0] !== 'object') {
          result[0] = {};
        }
        deepMerge && result.unshift(true);
        callback(extend.apply(null, result));
      } else {
        callback(result[0]);
      }
    } else if (isRawList) {
      callback(result);
    } else if (isHtml) {
      result = result.filter(noop);
      callback(result.length ? result : '');
    } else {
      callback(fileMgr.joinData(result, !isBin, charset));
    }
  };
  var isCors = CORS_RE.test(rule.matcher);
  var checkUrl = isJsHtml || isCssHtml;
  rule.list.forEach(function (r, i) {
    if (isJson) {
      var value = removeProtocol(getMatcher(r), true);
      var json = getMatcherJson(r, value);
      if (json) {
        result[i] = json;
        return execCallback();
      }
      value = value && value.trim();
      if (value) {
        if (isCors) {
          if (GEN_URL_RE.test(value)) {
            json = { origin: value };
          } else if (value === '*') {
            json = { '*': '' };
          } else if (CORS_KEY_RE.test(value)) {
            json = { enable: true };
          }
        }
        json = json || parsePureJSON(value, QUERY_PARAM_RE.test(value));
        if (json) {
          result[i] = json;
          return execCallback();
        }
      }
    }
    readRuleValue(
      r,
      function (value) {
        if (isHtml && value) {
          var props = r.lineProps;
          if (checkUrl) {
            var isUrl = isGenUrl(value);
            var wrap = isJsHtml ? wrapJs : wrapCss;
            value = wrap(isUrl ? value.trim() : value, charset, isUrl, props);
          } else {
            value = toBuffer(value, charset);
          }
          var strictHtml = props.strictHtml;
          var safeHtml = props.safeHtml;
          if (strictHtml || safeHtml) {
            value._strictHtml = strictHtml;
            value._safeHtml = safeHtml;
            r.lineStrict = strictHtml;
            r.lineSafe = safeHtml;
          }
        }
        result[i] = value;
        execCallback();
      },
      checkUrl,
      needRawData,
      req
    );
  });
}

exports.getRuleValue = function(rules, callback, noBody, charset, isHtml, req) {
  if (noBody || !rules) {
    return callback();
  }
  if (!Array.isArray(rules)) {
    rules = [rules];
  }
  spreadPromise(Promise.all(
    rules.map(function (rule) {
      return new Promise(function(resolve) {
        readRuleList(rule, resolve, false, charset, isHtml, req);
      });
    })
  ), callback);
};

function decodePath(path) {
  path = getPath(path, true);
  try {
    return decodeURIComponent(path);
  } catch (e) {
    logger.error(e);
  }

  try {
    return qs.unescape(path);
  } catch (e) {
    logger.error(e);
  }

  return path;
}

exports.getRuleFiles = function(rule, req) {
  var files = rule.files || [getPath(getUrl(rule))];
  var rawFiles = rule.rawFiles || files;
  var result = [];
  files.map(function (file, i) {
    var opts = pluginMgr.resolveKey(rawFiles[i], rule, req);
    if (opts) {
      result.push(opts);
    } else {
      file = getTempFilePath(file, rule);
      file = fileMgr.convertSlash(file);
      if (END_WIDTH_SEP_RE.test(file)) {
        result.push(file.slice(0, -1));
        result.push(join(file, 'index.html'));
      } else {
        result.push(file);
      }
    }
  });
  return result;
};

exports.getRuleFile = function(rule) {
  var filePath = getPath(getUrl(rule));
  if (!filePath) {
    return filePath;
  }
  return rule.root
    ? join(rule.root, decodePath(filePath))
    : decodePath(filePath);
};

function getValue(rule) {
  return rule.value || rule.path;
}

function trimUrl(url) {
  if (!url) {
    return url;
  }
  var index = url.indexOf('://');
  if (index === -1) {
    return url.trim();
  }
  index += 3;
  var protocol = url.substring(0, index);
  return protocol + url.substring(index).trim();
}

function getMatcher(rule) {
  return trimUrl(rule && (getValue(rule) || rule.matcher));
}

function getUrl(rule) {
  return trimUrl(rule && (getValue(rule) || rule.url));
}

exports.rule = {
  getMatcher: getMatcher,
  getUrl: getUrl
};

function getMatcherValue(rule) {
  rule = getMatcher(rule);
  return rule && removeProtocol(rule, true);
}

exports.getMatcherValue = getMatcherValue;

exports.getUrlValue = function(rule) {
  rule = getUrl(rule);
  return rule && removeProtocol(rule, true);
};

function _getRawType(type) {
  return typeof type === 'string' ? type.split(';')[0].toLowerCase() : '';
}

function getRawType(data) {
  return _getRawType(data.headers && data.headers['content-type']);
}

exports.getRawType = getRawType;

function getContentType(contentType) {
  if (contentType && typeof contentType != 'string') {
    contentType = contentType['content-type'] || contentType.contentType;
  }
  contentType = _getRawType(contentType);
  if (!contentType) {
    return;
  }
  if (contentType.indexOf('javascript') != -1) {
    return 'JS';
  }

  if (contentType.indexOf('css') != -1) {
    return 'CSS';
  }

  if (contentType.indexOf('html') != -1) {
    return 'HTML';
  }

  if (contentType.indexOf('json') != -1) {
    return 'JSON';
  }

  if (contentType.indexOf('xml') != -1) {
    return 'XML';
  }

  if (contentType.indexOf('text/') != -1) {
    return 'TEXT';
  }

  if (contentType.indexOf('image/') != -1) {
    return 'IMG';
  }
}

exports.getContentType = getContentType;

function isText(contentType) {
  contentType = contentType && getContentType(contentType);
  return contentType && contentType !== 'IMG';
}

exports.isText = isText;

function supportHtmlTransform(res, req) {
  var headers = res.headers;
  if (getContentType(headers) != 'HTML' || !hasBody(res, req)) {
    return false;
  }

  var contentEncoding = getContentEncoding(headers);
  //chrome新增了sdch压缩算法，对此类响应无法解码，deflate无法区分deflate还是deflateRaw
  return !contentEncoding || contentEncoding == 'gzip' || contentEncoding === 'br';
}

exports.supportHtmlTransform = supportHtmlTransform;

exports.getEnableEncoding = function(enable) {
  if (!enable) {
    return;
  }
  if (enable.br) {
    return supportsBr ? 'br' : null;
  }
  if (enable.gzip) {
    return 'gzip';
  }
  if (enable.deflate) {
    return 'deflate';
  }
};

function removeUnsupportsHeaders(headers, supportsDeflate) {
  //只保留支持的zip格式：gzip、deflate
  if (!headers || !headers['accept-encoding']) {
    return;
  }
  if (config.noGzip) {
    delete headers['accept-encoding'];
    return;
  }
  var list = headers['accept-encoding'].trim().split(/\s*,\s*/g);
  var acceptEncoding = [];
  for (var i = 0, len = list.length; i < len; i++) {
    var ae = list[i].toLowerCase();
    if (ae && ((supportsDeflate && ae == 'deflate') || ae == 'gzip' || (supportsBr && ae === 'br'))) {
      acceptEncoding.push(ae);
    }
  }

  if ((acceptEncoding = acceptEncoding.join(', '))) {
    headers['accept-encoding'] = acceptEncoding;
  }
}

exports.removeUnsupportsHeaders = removeUnsupportsHeaders;

function hasRequestBody(req) {
  req = typeof req == 'string' ? req : req.method;
  if (typeof req != 'string') {
    return false;
  }

  req = req.toUpperCase();
  return !(
    req === 'GET' ||
    req === 'HEAD' ||
    req === 'OPTIONS' ||
    req === 'CONNECT'
  );
}

exports.hasRequestBody = hasRequestBody;

function getContentEncoding(headers) {
  var encoding = toLowerCase(
    (headers && headers['content-encoding']) || headers
  );
  return encoding === 'gzip' || (supportsBr && encoding === 'br') ||
    encoding === 'deflate' ? encoding : null;
}

exports.getContentEncoding = getContentEncoding;

function getZipStream(headers) {
  switch (getContentEncoding(headers)) {
  case 'gzip':
    return zlib.createGzip();
  case 'br':
    return supportsBr && zlib.createBrotliCompress();
  case 'deflate':
    return zlib.createDeflate();
  }
}

exports.isZip = function(encoding, chunk) {
  if (encoding === 'gzip') {
    return chunk[0] === 31 && (chunk[1] == null || chunk[1] === 139);
  }
  if (encoding === 'br') {
    return supportsBr;
  }
  return encoding === 'deflate';
};

function getUnzipStream(headers) {
  switch (getContentEncoding(headers)) {
  case 'gzip':
    return zlib.createGunzip();
  case 'br':
    return supportsBr && zlib.createBrotliDecompress();
  case 'deflate':
    return zlib.createInflate();
  }
}

exports.getZipStream = getZipStream;
exports.getUnzipStream = getUnzipStream;
exports.isWhistleTransformData = function (obj) {
  if (!obj) {
    return false;
  }
  return obj.speed > 0 || obj.delay > 0 || obj.top || obj.body || obj.bottom;
};

function getPipeIconvStream(headers) {
  var pipeStream = new PipeStream();
  var charset = getCharset(headers['content-type']);

  if (charset) {
    pipeStream.addHead(iconv.decodeStream(charset));
    pipeStream.addTail(iconv.encodeStream(charset));
  } else {
    pipeStream.addHead(function (res, next) {
      var buffer, iconvDecoder;

      res.on('data', function (chunk) {
        buffer = buffer ? Buffer.concat([buffer, chunk]) : chunk;
        resolveCharset(buffer);
      });
      res.on('end', resolveCharset);

      function resolveCharset(chunk) {
        if (!charset) {
          if (chunk && buffer.length < 25600) {
            return;
          }
          charset = !buffer || isUtf8(buffer) ? 'utf8' : 'GB18030';
        }
        if (!iconvDecoder) {
          iconvDecoder = iconv.decodeStream(charset);
          next(iconvDecoder);
        }
        if (buffer) {
          iconvDecoder.write(buffer);
          buffer = null;
        }
        !chunk && iconvDecoder.end();
      }
    });

    pipeStream.addTail(function (src, next) {
      next(src.pipe(iconv.encodeStream(charset)));
    });
  }

  return pipeStream;
}

exports.getPipeIconvStream = getPipeIconvStream;

function toLowerCase(str) {
  return typeof str == 'string' ? str.trim().toLowerCase() : str;
}

exports.toLowerCase = toLowerCase;

function toUpperCase(str) {
  return typeof str == 'string' ? str.trim().toUpperCase() : str;
}

exports.toUpperCase = toUpperCase;

var CHARSET_RE = /charset=([\w-]+)/i;

function getCharset(str) {
  var charset;
  if (CHARSET_RE.test(str)) {
    charset = RegExp.$1;
    if (!iconv.encodingExists(charset)) {
      return;
    }
  }

  return charset;
}

exports.getCharset = getCharset;

function getClientIpFH(headers, name) {
  var val = headers[name];
  if (!isString(val)) {
    return '';
  }
  var index = val.indexOf(',');
  if (index !== -1) {
    val = val.substring(0, index);
  }
  val = removeIPV6Prefix(val.trim());
  return net.isIP(val) && !isLocalAddress(val) ? val : '';
}

function getForwardedFor(headers) {
  var ip = getClientIpFH(headers, config.CLIENT_IP_HEAD);
  var cipKey = config.cipKey;
  if (cipKey && (!ip || config.overCipKey)) {
    ip = getClientIpFH(headers, cipKey) || ip;
  }
  return ip;
}
exports.getForwardedFor = getForwardedFor;

function isLocalIp(ip) {
  if (!isString(ip)) {
    return true;
  }
  return ip.length < 7 || ip === LOCALHOST;
}

function getRemoteAddr(req) {
  try {
    var socket = req.socket || req;
    if (!socket._remoteAddr) {
      var ip = req.headers && req.headers[config.REMOTE_ADDR_HEAD];
      if (ip) {
        socket._remoteAddr = ip;
        delete req.headers[config.REMOTE_ADDR_HEAD];
      } else {
        socket._remoteAddr =
          removeIPV6Prefix(socket.remoteAddress) || LOCALHOST;
      }
    }
    return socket._remoteAddr;
  } catch (e) {}
  return LOCALHOST;
}

exports.getRemoteAddr = getRemoteAddr;

function getClientIp(req, ip) {
  ip = ip || getForwardedFor(req.headers || {}) || getRemoteAddr(req);
  return isLocalIp(ip) ? LOCALHOST : ip;
}

exports.getClientIp = getClientIp;

function getRemotePort(req) {
  try {
    var socket = req.socket || req;
    if (socket._remotePort == null) {
      var port = req.headers && req.headers[config.REMOTE_PORT_HEAD];
      if (port) {
        delete req.headers[config.REMOTE_PORT_HEAD];
      } else {
        port = socket.remotePort;
      }
      socket._remotePort = port > 0 ? port : '0';
    }
    return socket._remotePort;
  } catch (e) {}
  return 0;
}

exports.getRemotePort = getRemotePort;

exports.getClientPort = function (req) {
  var headers = req.headers || {};
  var port = headers[config.CLIENT_PORT_HEAD];
  if (port > 0) {
    return port;
  }
  return getRemotePort(req);
};

exports.removeIPV6Prefix = removeIPV6Prefix;

exports.isUrlEncoded = common.isUrlEncoded;

function isJSONContent(req) {
  if (!hasRequestBody(req)) {
    return false;
  }
  return getContentType(req.headers) === 'JSON';
}

exports.isJSONContent = isJSONContent;

function isProxyPort(proxyPort) {
  return (
    proxyPort == config.port ||
    proxyPort == config.httpsPort ||
    proxyPort == config.httpPort ||
    proxyPort == config.socksPort ||
    proxyPort == config.realPort
  );
}

exports.isProxyPort = isProxyPort;

exports.isLocalPHost = function(req, isHttps) {
  var phost = req._phost;
  var hostname = phost && phost.hostname;
  if (!hostname || !isProxyPort(phost.port || (isHttps ? 443 : 80))) {
    return false;
  }
  return isLocalHost(hostname);
};

function isMultipart(req) {
  return /multipart/i.test(req.headers['content-type']);
}

exports.isMultipart = isMultipart;

function getQueryString(url) {
  var index = url.indexOf('?');
  return index == -1 ? '' : url.substring(index + 1);
}

exports.getQueryString = getQueryString;

function replaceQueryString(query, replaceQuery, delProps) {
  if (replaceQuery && typeof replaceQuery != 'string') {
    replaceQuery = qs.stringify(replaceQuery);
  }
  if (delProps ? (!query && !replaceQuery) : (!query || !replaceQuery)) {
    return replaceQuery || query;
  }

  var queryList = [];
  var params = {};
  var curParams = {};
  var name, value;
  var parseKey = (item) => {
    var index = item.indexOf('=');
    if (index == -1) {
      name = item;
      value = '';
    } else {
      name = item.substring(0, index);
      value = item.substring(index + 1);
    }
  };
  var addValue = function(obj) {
    var curVal = obj[name];
    if (Array.isArray(curVal)) {
      curVal.push(value);
    } else if (curVal != null) {
      curVal = [curVal, value];
    }
    obj[name] = curVal || value;
  };
  if (replaceQuery) {
    replaceQuery = replaceQuery.split('&').map(function(item) {
      parseKey(item);
      if (!delProps || !delProps[name]) {
        addValue(params);
      }
    });
  }
  if (query) {
    query.split('&').map(function(item) {
      parseKey(item);
      if ((!delProps || !delProps[name]) && params[name] == null) {
        addValue(curParams);
      }
    });
  }
  extend(curParams, params);

  Object.keys(curParams).forEach(function(key) {
    var val = curParams[key];
    if (Array.isArray(val)) {
      val.forEach(function(v) {
        queryList.push(key + '=' + v);
      });
    } else {
      queryList.push(key + '=' + val);
    }
  });

  return queryList.join('&');
}

exports.replaceQueryString = replaceQueryString;

exports.replaceUrlQueryString = function(url, queryString) {
  if (!queryString) {
    return url;
  }
  url = url || '';
  var hashIndex = url.indexOf('#');
  var hashString = '';
  if (hashIndex != -1) {
    hashString = url.substring(hashIndex);
    url = url.substring(0, hashIndex);
  }
  queryString = replaceQueryString(getQueryString(url), queryString);

  return (
    url.replace(/\?.*$/, '') +
    (queryString ? '?' + queryString : '') +
    hashString
  );
};

exports.decodeBuffer = fileMgr.decode;

function setHeaders(data, obj) {
  if (!data.headers) {
    data.headers = {};
  }
  for (var i in obj) {
    data.headers[i] = obj[i];
  }
  return data;
}

exports.setHeaders = setHeaders;

function setHeader(data, name, value) {
  if (!data.headers) {
    data.headers = {};
  }
  data.headers[name] = value;
  return data;
}

exports.setHeader = setHeader;

function join(root, dir) {
  return root ? path.resolve(root, dir) : dir;
}

exports.join = join;

function resolveProperties(list, result) {
  result = result || {};
  if (list) {
    list
      .map(getMatcherValue)
      .join('|')
      .split(SEP_RE)
      .forEach(function (action) {
        if (action) {
          result[action] = true;
        }
      });
  }
  return result;
}

exports.resolveProperties = resolveProperties;

exports.parseLineProps = function (str) {
  str = str && removeProtocol(str, true);
  if (!str) {
    return;
  }
  var result = {};
  str.split(SEP_RE).forEach(function (action) {
    if (action) {
      result[action] = true;
    }
  });
  return result;
};

function resolveIgnore(ignore) {
  var keys = Object.keys(ignore);
  var exclude = {};
  var ignoreAll, disableIgnoreAll;
  ignore = {};
  keys.forEach(function (name) {
    if (name.indexOf('ignore.') === 0 || name.indexOf('ignore:') === 0) {
      exclude[name.substring(7)] = 1;
      return;
    }
    if (name.indexOf('-') === 0 || name.indexOf('!') === 0) {
      name = name.substring(1);
      if (name === '*') {
        disableIgnoreAll = true;
      } else {
        exclude[name] = 1;
      }
      return;
    }
    name = name.replace('ignore|', '');
    if (name === 'filter' || name === 'ignore') {
      return;
    }
    if (
      name === 'allRules' ||
      name === 'allProtocols' ||
      name === 'All' ||
      name === '*'
    ) {
      ignoreAll = true;
      return;
    }
    ignore[aliasProtocols[name] || name] = 1;
  });
  if (ignoreAll && !disableIgnoreAll) {
    protocols.forEach(function (name) {
      ignore[name] = 1;
    });
    keys = protocols;
  } else {
    keys = Object.keys(ignore);
  }
  keys.forEach(function (name) {
    if (exclude[name]) {
      delete ignore[name];
    }
  });
  return {
    ignoreAll: ignoreAll,
    exclude: exclude,
    ignore: ignore
  };
}

function resolveFilter(ignore, filter) {
  filter = filter || {};
  var result = resolveIgnore(ignore);
  ignore = result.ignore;
  Object.keys(ignore).forEach(function (name) {
    if (protocols.indexOf(name) === -1) {
      filter['ignore|' + name] = true;
    } else {
      filter[name] = true;
    }
  });
  Object.keys(result.exclude).forEach(function (name) {
    filter['ignore:' + name] = 1;
  });
  if (result.ignoreAll) {
    filter.allRules = 1;
  }
  return filter;
}

exports.resolveFilter = resolveFilter;

exports.isIgnored = function (filter, name) {
  return (
    !filter['ignore:' + name] && (filter[name] || filter['ignore|' + name])
  );
};

function exactIgnore(filter, rule) {
  if (filter['ignore|' + 'pattern=' + rule.rawPattern]) {
    return true;
  }
  if (filter['ignore|' + 'matcher=' + rule.matcher]) {
    return true;
  }
  return filter['ignore|' + 'matcher=' + rule.rawMatcher];
}

exports.exactIgnore = exactIgnore;

function notSkip(props, name) {
  return props['-' + name] || props['!' + name];
}

exports.checkSkip = function(skip, rule, curUrl) {
  if (skip['*'] && !notSkip(skip, '*')) {
    return true;
  }
  var proto = getProtocolName(rule.url || rule.matcher) || getProtocolName(curUrl);
  var name = rule.name;
  if ((skip[name] || skip[proto]) && !notSkip(skip, name) && !notSkip(skip, proto)) {
    return true;
  }
  return false;
};

function resolveRuleProps(rule, result) {
  result = result || {};
  if (rule) {
    rule.list.forEach(function (rule) {
      getMatcherValue(rule)
        .split(SEP_RE)
        .forEach(function (action) {
          result[action] = true;
        });
    });
  }
  return result;
}

var PLUGIN_RE = /^(?:plugin|whistle)\.[a-z\d_\-]+$/;
var enableRules = ['https', 'intercept', 'capture', 'hide'];

function ignorePlugins(rules, name, exclude) {
  var isPlugin = name === 'plugin';
  if (!isPlugin && !PLUGIN_RE.test(name)) {
    return;
  }
  if (rules.plugin) {
    var list = rules.plugin.list;
    for (var i = list.length - 1; i >= 0; i--) {
      var pName = getProtocolName(list[i].matcher);
      if ((isPlugin || name === pName) && !exclude[pName]) {
        list.splice(i, 1);
      }
    }
    if (!list.length) {
      delete rules.plugin;
    }
  }
  return true;
}

function getProtocolName(url) {
  return PROTO_NAME_RE.test(url) ? RegExp.$1 : '';
}

function ignoreForwardRule(rules, name, exclude) {
  var isRule = name === 'rule';
  if (!isRule && rules[name]) {
    return;
  }
  if (rules.rule) {
    var pName = getProtocolName(rules.rule.url);
    if ((isRule || name === pName) && !exclude[pName]) {
      delete rules.rule;
    }
  }
  return true;
}

function ignoreProxy(rules, name, exclude) {
  if (!rules.proxy) {
    return;
  }
  if (name === 'proxy') {
    delete rules.proxy;
    return true;
  }
  if (!PROXY_RE.test(name)) {
    return;
  }
  var pName = getProtocolName(rules.proxy.url);
  var realName = aliasProtocols[name] || name;
  var realPName = aliasProtocols[pName] || pName;
  if (realName === realPName && !exclude[pName] && !exclude[realPName]) {
    delete rules.proxy;
  }
  return true;
}

var EXACT_IGNORE_RE = /^(?:pattern|matcher)=./;

function ignoreRules(rules, ignore, isResRules) {
  var result = resolveIgnore(ignore);
  var ignoreAll = result.ignoreAll;
  var exclude = result.exclude;
  ignore = result.ignore;
  var keys = Object.keys(ignoreAll ? rules : ignore);
  var filter;
  keys.forEach(function (name) {
    if (EXACT_IGNORE_RE.test(name)) {
      filter = filter || {};
      filter['ignore|' + name] = true;
    }
    if (name === 'filter' || name === 'ignore' || exclude[name]) {
      return;
    }
    if (!isResRules || protoMgr.resProtocols.indexOf(name) !== -1) {
      if (
        ignorePlugins(rules, name, exclude) ||
        ignoreProxy(rules, name, exclude) ||
        ignoreForwardRule(rules, name, exclude)
      ) {
        return;
      }
      delete rules[name];
    }
  });
  if (filter) {
    Object.keys(rules).forEach(function(name) {
      var rule = rules[name];
      var list = rule.list;
      var matched = exactIgnore(filter, rule);
      if (list) {
        list = list.filter(function(r) {
          return !exactIgnore(filter, r);
        });
        if (!list.length) {
          delete rules[name];
        } else {
          if (matched) {
            rule = extend({}, list[0]);
            rules[name] = rule;
          }
          rule.list = list;
        }
      } else if (matched) {
        delete rules[name];
      }
    });
  }
}

exports.ignoreRules = ignoreRules;

function filterRepeatPlugin(rule) {
  if (rule.name !== 'plugin') {
    return;
  }
  var exists = {};
  rule.list = rule.list.filter(function (p) {
    var protocol = p.matcher.substring(
      p.matcher.indexOf('.'),
      p.matcher.indexOf(':')
    );
    if (!exists[protocol]) {
      exists[protocol] = 1;
      return true;
    }
    return false;
  });
}

exports.filterRepeatPlugin = filterRepeatPlugin;

function isImportant(rule) {
  return rule && rule.lineProps.important;
}

exports.isImportant = isImportant;

function mergeRule(curRule, newRule) {
  if (!curRule|| !newRule) {
    return curRule || newRule;
  }
  if (!curRule.list) {
    return isImportant(curRule) && !isImportant(newRule) ? curRule : newRule;
  }
  var list = newRule.list.concat(curRule.list);
  if (isImportant(curRule)) {
    var importants = [];
    var normals = [];
    for (var i = 0, len = list.length; i < len; i++) {
      var rule = list[i];
      if (isImportant(rule)) {
        importants.push(rule);
      } else {
        normals.push(rule);
      }
    }
    list = importants.concat(normals);
  }
  curRule.list = list;
  filterRepeatPlugin(curRule);
  return curRule;
}

function mergeRules(req, add, isResRules) {
  var origin = req.rules;
  var origAdd = add;
  add = add || {};
  var merge = function (protocol) {
    var rule = mergeRule(origin[protocol], add[protocol]);
    if (rule) {
      origin[protocol] = rule;
    }
  };
  if (isResRules && origAdd) {
    protoMgr.resProtocols.forEach(merge);
  } else if (origAdd) {
    Object.keys(origAdd).forEach(merge);
  }

  req['delete'] = resolveRuleProps(origin['delete'], req['delete']);
  req._filters = resolveRuleProps(origin.filter, req._filters);
  req.disable = resolveRuleProps(origin.disable, req.disable);
  req.ignore = resolveRuleProps(origin.ignore, req.ignore);
  req.enable = resolveRuleProps(origin.enable, req.enable);
  enableRules.forEach(function (rule) {
    if (req.enable[rule]) {
      req._filters[rule] = true;
    }
  });
  ignoreRules(origin, extend(req.ignore, req._filters), isResRules);
  return add;
}

exports.mergeRules = mergeRules;

function parseHeaderReplace(rule) {
  var list = rule && rule.list;
  if (!list) {
    return '';
  }
  var result = '';
  list.forEach(function (item) {
    var obj = parseJSON(getMatcherValue(item));
    var prop, name;
    obj &&
      Object.keys(obj).forEach(function (key) {
        var value = obj[key];
        if (!key.indexOf('req.') || !key.indexOf('reqH.')) {
          prop = 'req';
          name = null;
        } else if (!key.indexOf('res.') || !key.indexOf('resH.')) {
          prop = 'res';
          name = null;
        } else if (!key.indexOf('trailer.')) {
          prop = 'trailer';
          name = null;
        } else if (!prop) {
          return;
        }
        result = result || {};
        var index = key.indexOf(':');
        name = name || key.substring(key.indexOf('.') + 1, index).trim();
        if (!name) {
          return;
        }
        key = key.substring(index + 1);
        var pattern = toOriginalRegExp(key);
        var opList = result[prop];
        var op = {
          regExp: pattern,
          name: name.toLowerCase(),
          key: key,
          value: value
        };
        if (opList) {
          opList.push(op);
        } else {
          result[prop] = opList = [op];
        }
      });
  });
  return result;
}

exports.parseHeaderReplace = parseHeaderReplace;

function replaceHeader(str, regExp, key, value) {
  if (str == null || str === '') {
    return str;
  }
  str = String(str);
  if (!regExp || !SUB_MATCH_RE.test(value)) {
    return str.replace(regExp || key, value);
  }
  return str.replace(regExp, function () {
    return replacePattern(value, arguments);
  });
}

function handleHeaderReplace(headers, opList) {
  opList &&
    opList.forEach(function (item) {
      var header = headers[item.name];
      if (header == null || header === '') {
        return;
      }
      var regExp = item.regExp;
      var key = item.key;
      var value = item.value;
      if (Array.isArray(header)) {
        headers[item.name] = header.map(function (str) {
          return replaceHeader(str, regExp, key, value);
        });
      } else {
        headers[item.name] = replaceHeader(header, regExp, key, value);
      }
    });
}

exports.handleHeaderReplace = handleHeaderReplace;

var HTML_RE = /html/i;

exports.transformReq = function(req, res, port, host, html) {
  var options = common.getReqOptions(req, port, host);
  var headers = req.headers;
  if (req.fromComposer) {
    headers[config.REQ_FROM_HEADER] = 'W2COMPOSER';
  } else if (req.fromInternalPath) {
    headers[config.REQ_FROM_HEADER] = 'W2INTERNAL_PATH';
  }
  if (req.clientIp || !net.isIP(headers[config.CLIENT_IP_HEAD])) {
    var clientIp = req.clientIp || getClientIp(req);
    if (isLocalAddress(clientIp)) {
      delete headers[config.CLIENT_IP_HEAD];
    } else {
      headers[config.CLIENT_IP_HEAD] = clientIp;
    }
  }
  options.hostname = null;
  html && removeUnsupportsHeaders(headers);
  var destroyed;
  var abort = function () {
    if (!destroyed) {
      destroyed = true;
      client.destroy();
    }
  };
  var client = http.request(options, function (_res) {
    var resHeaders = _res.headers;
    var origin =
      !resHeaders['access-control-allow-origin'] && req.headers.origin;
    if (origin) {
      resHeaders['access-control-allow-origin'] = origin;
      resHeaders['access-control-allow-credentials'] = true;
    }
    if (getStatusCode(_res.statusCode)) {
      var type = resHeaders['content-type'];
      if (html && (!type || HTML_RE.test(type)) && hasBody(_res)) {
        var unzip = getUnzipStream(resHeaders);
        var zip = getZipStream(resHeaders);
        delete resHeaders['content-length'];
        res.writeHead(_res.statusCode, resHeaders);
        if (unzip && zip) {
          unzip.on('error', abort);
          zip.on('error', abort);
          zip.write(html);
          _res.pipe(unzip).pipe(zip).pipe(res);
        } else {
          res.write(html);
          _res.pipe(res);
        }
      } else {
        res.writeHead(_res.statusCode, resHeaders);
        _res.pipe(res);
      }
    } else {
      sendStatusCodeError(res, _res);
    }
  });
  req.on('error', abort);
  res.on('error', abort);
  res.once('close', abort);
  client.on('error', function (err) {
    abort();
    res.emit('error', err);
  });
  req.pipe(client);
  return client;
};

function trimStr(str) {
  if (typeof str !== 'string') {
    return '';
  }
  return str.trim();
}

exports.trimStr = trimStr;

function hasHeaderRules(headers) {
  return (
    headers['x-whistle-rule-key'] ||
    headers['x-whistle-rule-value'] ||
    headers['x-whistle-rule-host']
  );
}

function checkIfAddInterceptPolicy(proxyHeaders, headers) {
  if (hasHeaderRules(headers)) {
    proxyHeaders['x-whistle-policy'] = 'intercept';
    return true;
  }
}

exports.checkIfAddInterceptPolicy = checkIfAddInterceptPolicy;

function getCgiUrl(url) {
  if (!isString(url) || !(url = url.trim())) {
    return;
  }
  if (url[0] === '.' && url[1] === '/') {
    url = url.substring(2);
  } else {
    url = url[0] === '/' ? url.substring(1) : url;
  }
  return url.substring(0, 10240);
}
exports.getCgiUrl = getCgiUrl;

exports.getInstallRegistry = function(registry) {
  if (Array.isArray(registry)) {
    var result;
    registry.slice(0, 3).forEach(function (reg) {
      reg = common.getRegistry(reg);
      if (reg) {
        result = result || [];
        result.push(reg);
      }
    });
    return result;
  }
  registry = common.getRegistry(registry);
  return registry && [registry];
};

exports.getCustomTab = function (tab, pluginName) {
  if (!tab || !isString(tab.name)) {
    return;
  }
  var name = tab.name.trim();
  var page = getPage(tab.page || tab.action);
  if (!name || !page || page.indexOf('#') !== -1) {
    return;
  }
  return {
    action: 'plugin.' + pluginName + '/' + page,
    name: name.substring(0, 32),
    icon: getCgiUrl(tab.icon || tab.iconUrl)
  };
};

function checkStyle(style) {
  if (!style || style > 0) {
    return style;
  }
  if (typeof style !== 'string') {
    return;
  }
  return style.substring(0, 32);
}

exports.getPluginModal = function(conf) {
  var modal = conf.openInModal || conf.openInDialog;
  if (!modal) {
    return;
  }
  var result;
  var width = checkStyle(modal.width);
  var height = checkStyle(modal.height);
  if (width) {
    result = { width: width };
  }
  if (height) {
    result = result || {};
    result.height = height;
  }
  return result || 1;
};

function getString(str) {
  if (!isString(str)) {
    return;
  }
  return str.trim();
}

exports.getString = getString;

function getPage(page) {
  page = getCgiUrl(page);
  return !page || page.length > 128 || !/\.html?$/i.test(page) ? null : page;
}

exports.getPluginMenu = function (menus, pluginName) {
  if (!Array.isArray(menus)) {
    return;
  }
  var len = menus.length;
  var count = 5;
  var map = {};
  var result, menu, name, page;
  for (var i = 0; i < len; i++) {
    if (
      (menu = menus[i]) &&
      (name = getString(menu.name)) &&
      !map[name] &&
      (page = getPage(menu.page || menu.action)) &&
      page.indexOf('#') === -1
    ) {
      result = result || [];
      map[name] = 1;
      var pattern = menu.urlPattern;
      result.push({
        name: name.substring(0, 20),
        action: 'plugin.' + pluginName + '/' + page,
        required: menu.required ? true : undefined,
        requiredTreeNode: menu.requiredTreeNode ? true : undefined,
        urlPattern: isRegExp(pattern) && pattern.length < 256 ? pattern : undefined
      });
      if (--count === 0) {
        return result;
      }
    }
  }
  return result;
};

exports.getNetworkColumn = function(conf) {
  var column = conf.networkColumn;
  var title = column && (column.title || column.name);
  var key = title && column.key;
  if (!isString(title) || !isString(key)) {
    return;
  }
  return {
    title: title.substring(0, 16),
    key: key.substring(0, 72),
    iconKey: isString(column.iconKey) ? column.iconKey.substring(0, 72) : undefined,
    showTitle: (column.showTips || column.showTitle) ? 1 : undefined,
    width: Math.min(360, Math.max(parseInt(column.width) || 120, 70))
  };
};

exports.getWebWorker = function(conf) {
  var webWorker = conf.webWorker;
  if (!isString(webWorker)) {
    return;
  }
  webWorker = toRelPath(webWorker);
  return webWorker && webWorker.length <= 120 ? webWorker : undefined;
};

var MAX_HINT_LEN = 512;
var MAX_VAR_LEN = 100;

function getHintList(conf, isVar) {
  var hintList = conf.hintList;
  if (!Array.isArray(hintList) || !hintList.length) {
    return;
  }
  var result;
  var maxLen = isVar ? MAX_VAR_LEN : MAX_HINT_LEN;
  hintList.forEach(function (hint) {
    if (typeof hint === 'string') {
      if (hint.length <= maxLen) {
        result = result || [];
        result.push(hint);
      }
    } else if (hint) {
      var text = hint.text || hint.value;
      text = typeof text === 'string' ? text.trim() : '';
      if (!text) {
        return;
      }
      var help = hint.help;
      var isKey = hint.isKey ? 1 : undefined;
      var displayText = hint.display || hint.displayText || hint.label;
      if (typeof help !== 'string') {
        help = '';
      }
      if (typeof displayText !== 'string') {
        displayText = '';
      }
      result = result || [];
      if (!isKey && !help && !displayText) {
        result.push(text);
      } else {
        result.push({
          isKey: isKey,
          text: text,
          help: help.trim(),
          displayText: displayText
        });
      }
    }
  });
  return result;
}

exports.getHintList = getHintList;

var HINT_SUFFIX_RE = /^[.=][^\s]*$/;

exports.getPluginVarsConf = function (conf) {
  var pluginVars = conf.pluginVars;
  if (!pluginVars) {
    return;
  }
  var varHintList = getHintList(pluginVars, true);
  var hintSuffix = pluginVars.hintSuffix;
  var varHintUrl = varHintList ? undefined : getCgiUrl(pluginVars.hintUrl);
  if (Array.isArray(hintSuffix)) {
    hintSuffix = hintSuffix.filter(function(suffix) {
      return HINT_SUFFIX_RE.test(suffix);
    });
    var len = hintSuffix.length;
    if (!len) {
      hintSuffix = undefined;
    } else if (len > 10) {
      hintSuffix = hintSuffix.slice(0, 10);
    }
  } else {
    hintSuffix = undefined;
  }
  if (varHintList || varHintUrl || hintSuffix) {
    return {
      hintSuffix: hintSuffix,
      hintUrl: varHintUrl,
      hintList: varHintList
    };
  }
  return true;
};

function toRelPath(str) {
  return str.replace(/^\/+/, '');
}

exports.getStaticDir = function (conf) {
  var staticDir = conf.staticDir;
  if (
    !staticDir ||
    typeof staticDir !== 'string' ||
    !/^[\w./-]+$/.test(staticDir) ||
    staticDir.length > 100
  ) {
    return;
  }
  return toRelPath(staticDir.replace(/^\/+/, ''));
};

function toString(str) {
  if (str != null) {
    if (typeof str === 'string') {
      return str;
    }
    try {
      return JSON.stringify(str);
    } catch (e) {}
  }
  return '';
}
exports.toString = toString;

var index = 0;

function padReqId(num) {
  if (num > 99) {
    return num;
  }
  if (num > 9) {
    return '0' + num;
  }
  return '00' + num;
}

exports.getReqId = function (now) {
  if (index > 999) {
    index = 0;
  }
  return (now || Date.now()) + '-' + padReqId(index++) + workerIndex;
};

exports.onSocketEnd = common.onSocketEnd;
exports.onResEnd = common.onResEnd;

exports.getEmptyRes = function getRes() {
  var res = common.createTransform();
  res._transform = noop;
  res.on('data', noop);
  res.destroy = noop;
  return res;
};

var REQ_HEADER_RE = /^req\.?H(?:eaders?)?\.(.+)$/i;
var RES_HEADER_RE = /^res\.?H(?:eaders?)?\.(.+)$/i;
var TRAILER_RE = /trailer\.(.+)$/;
var HEADER_RE = /^headers\.(.+)$/;
var REQ_COOKIE_RE = /^req\.?C(?:ookies?)?\.(.+)$/i;
var RES_COOKIE_RE = /^res\.?C(?:ookies?)?\.(.+)$/i;
var REQ_BODY_RE = /^req\.?B(?:ody?)?\.(.+)$/i;
var RES_BODY_RE = /^res\.?B(?:ody?)?\.(.+)$/i;
var COOKIE_RE = /^cookies?\.(.+)$/i;
var QUERY_RE = /^(?:query|params|url\.?Params?)\.(.+)$/i;
var QUERY_STRING_RE = /^(?:query|params|url\.?Params?)$/i;

exports.parseDelQuery = function(req, delType) {
  var query;
  var deleteRule = req['delete'];
  if (deleteRule) {
    Object.keys(deleteRule).forEach(function (prop) {
      if (QUERY_RE.test(prop)) {
        query = query || {};
        query[RegExp.$1] = 1;
      } else if (QUERY_STRING_RE.test(prop)) {
        req._delQueryString = true;
      } else if (delType) {
        if (prop === 'reqType' || prop === 'req.type') {
          delType.reqType = true;
        } else if (prop === 'reqCharset' || prop === 'req.charset') {
          delType.reqCharset = true;
        }
      }
    });
  }
  return query;
};

exports.deleteQuery = function(url, props, clear) {
  if (!props && !clear) {
    return url;
  }
  var index = url.indexOf('?');
  if (index === -1) {
    return url;
  }
  if (clear) {
    return url.substring(0, index);
  }
  var query = url.substring(index + 1);
  if (!query) {
    return url;
  }
  query = query.split('&').filter(function(item) {
    var i = item.indexOf('=');
    return !props[i === -1 ? item : item.substring(0, i)];
  }).join('&');
  return url.substring(0, query ? index + 1 : index) + query;
};

function parseDeleteRule(req, p1, p2) {
  var result;
  var deleteRule = req['delete'];
  if (deleteRule) {
    Object.keys(deleteRule).forEach(function (prop) {
      if ((p1 && p1.test(prop)) || (p2 && p2.test(prop))) {
        result = result || {};
        result[RegExp.$1] = 1;
      }
    });
  }
  return result;
}

function parseDelReqCookies(req) {
  return parseDeleteRule(req, REQ_COOKIE_RE, COOKIE_RE);
}

exports.parseDelReqBody = function(req) {
  return parseDeleteRule(req, REQ_BODY_RE);
};

exports.parseDelResBody = function(req) {
  return parseDeleteRule(req, RES_BODY_RE);
};

exports.deleteProps = function(obj, keys) {
  keys = obj && keys && Object.keys(keys);
  if (!keys || !keys.length) {
    return;
  }
  keys.forEach(function(key) {
    common.deleteProps(obj, key);
  });
};

function getDomain(req) {
  var host = req._w2hostname;
  if (typeof host !== 'string') {
    return;
  }
  host = host.split('.');
  var len = host.length;
  if (len < 3) {
    return;
  }
  if (len === 3) {
    host[0] = '';
  } else {
    host.shift();
  }
  return host.join('.');
}

function parseDelResCookies(req) {
  var resCookies;
  var deleteRule = req['delete'];
  if (deleteRule) {
    Object.keys(deleteRule).forEach(function (prop) {
      if (RES_COOKIE_RE.test(prop) || COOKIE_RE.test(prop)) {
        resCookies = resCookies || {};
        var list = [EXP_COOKIE, EXP_SECURE_COOKIE];
        resCookies[RegExp.$1] = list;
        var domain = getDomain(req);
        if (domain) {
          EXP_COOKIE_D.domain = domain;
          EXP_SECURE_COOKIE_D.domain = domain;
          list.push(EXP_COOKIE_D, EXP_SECURE_COOKIE_D);
        }
      }
    });
  }
  return resCookies;
}

exports.parseDelProps = function(req) {
  var deleteRule = req['delete'];
  var resHeaders;
  var trailers;
  var resType;
  var resCharset;

  if (deleteRule) {
    Object.keys(deleteRule).forEach(function (prop) {
      if (RES_HEADER_RE.test(prop)) {
        resHeaders = resHeaders || {};
        resHeaders[RegExp.$1.toLowerCase()] = 1;
      } else if (HEADER_RE.test(prop)) {
        resHeaders = resHeaders || {};
        resHeaders[RegExp.$1.toLowerCase()] = 1;
      } else if (TRAILER_RE.test(prop)) {
        trailers = trailers || {};
        trailers[RegExp.$1.toLowerCase()] = 1;
      } else if (prop === 'resType' || prop === 'res.type') {
        resType = true;
      } else if (prop === 'resCharset' || prop === 'res.charset') {
        resCharset = true;
      }
    });
  }
  return {
    resHeaders: resHeaders,
    trailers: trailers,
    resType: resType,
    resCharset: resCharset
  };
};

function parseDelResHeaders(req) {
  var deleteRule = req['delete'];
  var result;

  if (deleteRule) {
    Object.keys(deleteRule).forEach(function (prop) {
      if (RES_HEADER_RE.test(prop)) {
        result = result || {};
        result[RegExp.$1.toLowerCase()] = 1;
      } else if (HEADER_RE.test(prop)) {
        result = result || {};
        result[RegExp.$1.toLowerCase()] = 1;
      }
    });
  }
  return result;
}

exports.deleteResHeaders = function(req, headers) {
  var props = parseDelResHeaders(req);
  if (props) {
    Object.keys(props).forEach(function (name) {
      delete headers[name];
    });
  }
};

function parseDelReqHeaders(req) {
  var result;
  var deleteRule = req['delete'];
  if (deleteRule) {
    Object.keys(deleteRule).forEach(function (prop) {
      if (REQ_HEADER_RE.test(prop)) {
        result = result || {};
        result[RegExp.$1.toLowerCase()] = 1;
      } else if (HEADER_RE.test(prop)) {
        result = result || {};
        result[RegExp.$1.toLowerCase()] = 1;
      }
    });
  }
  return result;
}

exports.deleteReqHeaders = function (req) {
  var props = parseDelReqHeaders(req);
  if (props) {
    var headers = req.headers;
    Object.keys(props).forEach(function (name) {
      delete headers[name];
    });
  }
};


function parseOrigin(origin) {
  if (!isString(origin)) {
    return;
  }
  var index = origin.indexOf('//');
  if (index !== -1) {
    index = origin.indexOf('/', index + 2);
    if (index != -1) {
      origin = origin.substring(0, index);
    }
  }
  return origin;
}

exports.setReqCors = function (data, cors) {
  if (!cors) {
    return;
  }
  cors = lowerCaseify(cors);
  var origin;
  if (cors.origin === '*') {
    origin = cors.origin;
  } else if (isUrl(cors.origin)) {
    origin = parseOrigin(cors.origin);
  }
  if (origin !== undefined) {
    setHeader(data, 'origin', origin);
  } else if (cors['*'] === '') {
    setHeader(data, 'origin', '*');
  }
  if (cors.method !== undefined) {
    setHeader(data, 'access-control-request-method', cors.method);
  }
  if (cors.headers !== undefined) {
    setHeader(data, 'access-control-request-headers', cors.headers);
  }
};

exports.setResCors = function (data, cors, req) {
  if (!cors) {
    return;
  }
  cors = lowerCaseify(cors);
  var cusOrigin;
  if (cors.origin === '*') {
    cusOrigin = cors.origin;
  } else if (isUrl(cors.origin)) {
    cusOrigin = parseOrigin(cors.origin);
  }
  var isEnable = cors.enable;
  var isOptions = req.method === 'OPTIONS';
  var isStar = cors['*'] === '';
  if (cusOrigin || isEnable) {
    var origin = cusOrigin || req.headers.origin;
    if (origin) {
      setHeaders(data, {
        'access-control-allow-credentials': true,
        'access-control-allow-origin': origin
      });
    }
  } else if (isStar) {
    setHeader(data, 'access-control-allow-origin', '*');
  }

  if (cors.methods !== undefined) {
    setHeader(data, 'access-control-allow-methods', cors.methods);
  }
  var autoComp = isOptions && (isStar || isEnable);
  if (cors.headers !== undefined) {
    var operate = isOptions ? 'allow' : 'expose';
    setHeader(data, 'access-control-' + operate + '-headers', cors.headers);
  } else if (autoComp) {
    var headers = req.headers['access-control-request-headers'];
    if (headers) {
      setHeader(data, 'access-control-allow-headers', headers);
    }
  }

  if (cors.credentials !== undefined) {
    setHeader(data, 'access-control-allow-credentials', cors.credentials);
  } else if (autoComp) {
    var method = req.headers['access-control-request-method'];
    if (method) {
      setHeader(data, 'access-control-allow-method', method);
    }
  }

  if (cors.maxage !== undefined) {
    setHeader(data, 'access-control-max-age', cors.maxage);
  }
};

exports.disableReqProps = function (req) {
  var disable = req.disable;
  var headers = req.headers;

  if (disable.ua) {
    delete headers['user-agent'];
  }

  if (disable.gzip || isEnable(req, 'captureStream')) {
    delete headers['accept-encoding'];
  }

  if (
    disable.cookie ||
    disable.cookies ||
    disable.reqCookie ||
    disable.reqCookies
  ) {
    delete headers.cookie;
  }

  if (disable.referer || disable.referrer) {
    delete headers.referer;
  }

  if (disable.ajax) {
    delete headers['x-requested-with'];
  }

  if (disable.cache) {
    disableReqCache(headers);
  }
};

exports.disableResProps = function (req, headers) {
  var disable = req.disable;
  if (
    disable.cookie ||
    disable.cookies ||
    disable.resCookie ||
    disable.resCookies
  ) {
    delete headers['set-cookie'];
  }
  if (disable.cache) {
    headers['cache-control'] = 'no-cache';
    headers.expires = new Date(Date.now() - 60000000).toGMTString();
    headers.pragma = 'no-cache';
  }
  disable.csp && disableCSP(headers);
};

var G_INVALID_NAME_CHAR_RE = /[^\x00-\xFF]|[\r\n;=%]/gu;
var INVALID_NAME_CHAR_RE = /[\r\n;=]/;
function escapeName(name) {
  if (
    !name ||
    (!NON_LATIN1_RE.test(name) && !INVALID_NAME_CHAR_RE.test(name))
  ) {
    return name;
  }
  return name.replace(G_INVALID_NAME_CHAR_RE, safeEncodeURIComponent);
}

var G_INVALID_VALUE_CHAR_RE = /[^\x00-\xFF]|[\r\n;%]/gu;
var INVALID_VALUE_CHAR_RE = /[\r\n;]/;
function escapeValue(value) {
  if (!isString(value)) {
    return (value = value == null ? '' : String(value));
  }
  if (!NON_LATIN1_RE.test(value) && !INVALID_VALUE_CHAR_RE.test(value)) {
    return value;
  }
  return value.replace(G_INVALID_VALUE_CHAR_RE, safeEncodeURIComponent);
}

exports.setReqCookies = function (data, cookies, curCookies, req) {
  var list = cookies && Object.keys(cookies);
  var notEmpty = list && list.length;
  var delKeys = parseDelReqCookies(req);
  if (!notEmpty && (!delKeys || !curCookies)) {
    return;
  }
  var result = {};
  if (isString(curCookies)) {
    curCookies.split(/;\s*/g).forEach(function (cookie) {
      var index = cookie.indexOf('=');
      var key = cookie;
      var value = null;
      if (index !== -1) {
        key = cookie.substring(0, index);
        value = cookie.substring(index + 1);
      }
      if (!delKeys || !delKeys[key]) {
        result[key] = value;
      }
    });
  }

  notEmpty && list.forEach(function (name) {
    var escName = escapeName(name);
    if (!delKeys || (!delKeys[name] && !delKeys[escName])) {
      var value = cookies[name];
      value = value && typeof value == 'object' ? value.value : value;
      result[escName] = value ? escapeValue(value) : value;
    }
  });

  cookies = Object.keys(result)
    .map(function (name) {
      var value = result[name];
      return name + '=' + (value == null ? '' : value);
    })
    .join('; ');
  setHeader(data, 'cookie', cookies);
};

function getCookieItem(name, cookie) {
  if (!cookie || typeof cookie != 'object') {
    cookie = cookie ? escapeValue(cookie) : cookie;
    return name + '=' + (cookie == null ? '' : cookie);
  }
  var attrs = [name + '=' + escapeValue(cookie.value)];
  var maxAge = cookie.maxAge ||  cookie.maxage ||
      cookie.MaxAge || cookie['Max-Age'] || cookie['max-age'];
  maxAge = parseInt(cookie.maxAge, 10);
  if (!Number.isNaN(maxAge)) {
    attrs.push('Expires=' + new Date(Date.now() + maxAge * 1000).toGMTString());
    attrs.push('Max-Age=' + (maxAge === EXPIRED_SEC ? 0 : maxAge));
  }

  (cookie.secure || cookie.Secure) && attrs.push('Secure');
  (cookie.httpOnly || cookie.HttpOnly || cookie.httponly) && attrs.push('HttpOnly');
  (cookie.partitioned || cookie.Partitioned) && attrs.push('Partitioned');
  var path = cookie.path || cookie.Path;
  var domain = cookie.domain || cookie.Domain;
  var sameSite = cookie.sameSite || cookie.samesite || cookie.SameSite;
  path && attrs.push('Path=' + path);
  domain && attrs.push('Domain=' + domain);
  sameSite && attrs.push('SameSite=' + sameSite);
  return attrs.join('; ');
}

function addMapArr(obj, key, value) {
  var arr = obj[key] || [];
  arr.push(value);
  obj[key] = arr;
}

exports.setResCookies = function (data, cookies, req) {
  var delKeys = parseDelResCookies(req);
  if (delKeys) {
    cookies = cookies ? extend(cookies, delKeys) : delKeys;
  }
  var list = cookies && Object.keys(cookies);
  var notEmpty = list && list.length;
  if (!notEmpty) {
    return;
  }
  var curCookies = data.headers && data.headers['set-cookie'];
  if (!Array.isArray(curCookies)) {
    curCookies = curCookies ? [curCookies + ''] : [];
  }

  var curData = {};
  curCookies.forEach(function (cookie) {
    var index = cookie.indexOf('=');
    var key = cookie;
    if (index !== -1) {
      key = cookie.substring(0, index);
    }
    addMapArr(curData, key, cookie);
  });
  var result = {};
  list.forEach(function (name) {
    var cookie = cookies[name];
    name = escapeName(name);
    if (Array.isArray(cookie)) {
      cookie.forEach(function(value) {
        addMapArr(result, name, getCookieItem(name, value));
      });
    } else {
      addMapArr(result, name, getCookieItem(name, cookie));
    }
  });
  extend(curData, result);
  result = [];
  Object.keys(curData).forEach(function (name) {
    curData[name].forEach(function(value) {
      result.push(value);
    });
  });
  setHeader(data, 'set-cookie', result);
};

exports.escapeRegExp = common.escapeRegExp;

exports.checkTlsError = function (err) {
  if (!err) {
    return false;
  }
  if (err.code === 'EPROTO') {
    return true;
  }
  var stack = err.stack || err.message;
  if (!isString(stack)) {
    return false;
  }
  if (
    stack.indexOf('TLSSocket.onHangUp') !== -1 ||
    stack.indexOf('statusCode=502') !== -1
  ) {
    return true;
  }
  return stack.toLowerCase().indexOf('openssl') !== -1;
};
exports.checkAuto2Http = function (req, ip, proxyUrl) {
  return (
    !req.disable.auto2http &&
    (req.enable.auto2http ||
      req.rules.host ||
      (proxyUrl ? req._phost : isLocalAddress(ip)))
  );
};

exports.setProxyHost = function (req, options, reserve) {
  var phost = req._phost || options;
  var opts = reserve ? options : extend({}, options);
  opts.host = phost.hostname;
  if (phost.port > 0) {
    opts.port = phost.port;
  }
  opts.headers = opts.headers || {};
  config.setHeader(opts.headers, 'host', joinIpPort(opts.host, opts.port));
  return opts;
};

function getMethod(method) {
  if (typeof method !== 'string') {
    return 'GET';
  }
  return method.trim().toUpperCase() || 'GET';
}

exports.getMethod = getMethod;

var RESPONSE_FOR_NAME = /^name=(.+)$/;
exports.setResponseFor = function (rules, headers, req, serverIp, phost) {
  var responseFor = getMatcherValue(rules.responseFor);
  phost = phost && phost.host;
  if (!responseFor) {
    if (req.isPluginReq) {
      var isLocal1 = isLocalAddress(serverIp);
      var isLocal2 = !phost || isLocalAddress(phost);
      if (!isLocal1 || !isLocal2) {
        responseFor = trimStr(headers['x-whistle-response-for']);
        responseFor = responseFor
          ? responseFor.split(',').map(trim).filter(noop)
          : [];
        if (!isLocal2 && responseFor.indexOf(phost) === -1) {
          responseFor.push(phost);
        }
        if (!isLocal1 && responseFor.indexOf(serverIp) === -1) {
          responseFor.push(serverIp);
        }
        headers['x-whistle-response-for'] = responseFor.join(', ');
      }
    }
    return;
  }
  var reqHeaders = req.headers;
  if (RESPONSE_FOR_NAME.test(responseFor)) {
    var result = RegExp.$1.toLowerCase().split(',');
    var reqResult = [];
    result = result
      .map(function (name) {
        if (name.indexOf('req.') === 0) {
          name = reqHeaders[name.substring(4)];
          name && reqResult.push(name);
          return;
        }
        return headers[name];
      })
      .filter(noop);
    if (phost && result.indexOf(phost) === -1) {
      result.push(phost);
    }
    serverIp = serverIp || '127.0.0.1';
    if (result.indexOf(serverIp) === -1) {
      result.push(serverIp);
    }
    responseFor = result.concat(reqResult).join(', ');
  }
  headers['x-whistle-response-for'] = responseFor;
};

var CONFIG_VAR_RE = /\${(port|version)}/gi;
var PLUGIN_RULES_URL_RE = /^whistle\.([a-z\d_-]+)(?:$|\/)/i;
var PLUGIN_KEY_RE =/^\$(?:whistle\.)?([a-z\d_-]+)[/:]([\S\s]+)$/;
var REL_PATH_RE = /^[\w.-]+(?:[\\/]|$)/;

function setConfigVarFn(_, name) {
  return config[name.toLowerCase()];
}

exports.getRemoteRules = function (apo, rulesUrl, root) {
  var headers = config.runtimeHeaders;
  var pluginName;
  if (PLUGIN_RULES_URL_RE.test(rulesUrl)) {
    pluginName = RegExp.$1;
    rulesUrl = pluginName + '/' + rulesUrl.substring(RegExp['$&'].length);
    headers = config.pluginHeaders;
  } else if (PLUGIN_KEY_RE.test(rulesUrl)) {
    pluginName = RegExp.$1;
    rulesUrl = pluginName + '/api/key/value?key=' + safeEncodeURIComponent(RegExp.$2);
    headers = config.pluginHeaders;
  }
  if (apo) {
    rulesUrl = rulesUrl.replace(CONFIG_VAR_RE, setConfigVarFn);
  }
  if (root && !pluginName && REL_PATH_RE.test(rulesUrl)) {
    rulesUrl = join(root, rulesUrl);
  }
  return httpMgr.add(rulesUrl, headers, pluginName);
};

function isCustomParser(req) {
  var enable = req.enable;
  return enable && (enable.customParser || enable.customFrames);
}
exports.isCustomParser = isCustomParser;

exports.getParserStatus = function (req) {
  if (!isCustomParser(req)) {
    return;
  }
  var enable = req.enable;
  var customParser = ['custom'];
  if (enable.pauseSend) {
    customParser.push('pauseSend');
  } else if (enable.ignoreSend) {
    customParser.push('ignoreSend');
  }
  if (enable.pauseReceive) {
    customParser.push('pauseReceive');
  } else if (enable.ignoreReceive) {
    customParser.push('ignoreReceive');
  }
  return customParser.join();
};

exports.isInspect = function (enable) {
  return (
    enable.inspect ||
    enable.pauseReceive ||
    enable.pauseSend ||
    enable.ignoreReceive ||
    enable.ignoreSend
  );
};

var BYTES_RANGE_RE = /^\s*bytes=/i;

exports.parseRange = function (req, size) {
  var range = size && req.headers.range;
  if (!range || !BYTES_RANGE_RE.test(range)) {
    return;
  }
  range = range.substring(range.indexOf('=') + 1).trim();
  if (!range) {
    return;
  }
  var start = size;
  var end = -1;
  range = range.split(',').forEach(function (item) {
    item = item.split('-');
    var s = parseInt(item[0], 10);
    var e = parseInt(item[1], 10);
    if (isNaN(s)) {
      if (isNaN(e)) {
        return;
      }
      s = size - e;
    } else if (isNaN(e)) {
      e = size - 1;
    }
    start = Math.min(s, start);
    end = Math.max(end, e);
  });
  if (start < 0 || end < 0 || start > end || end >= size) {
    return;
  }
  return {
    start: start,
    end: end
  };
};

exports.parseClientInfo = function (req) {
  var clientInfo = req.headers[config.CLIENT_INFO_HEAD] || '';
  if (req.headers[config.REQ_FROM_HEADER] === 'W2COMPOSER') {
    req.fromComposer = true;
    req._disabledProxyRules = !!req.headers[config.DISABLE_RULES_HEADER];
    delete req.headers[config.REQ_FROM_HEADER];
    delete req.headers[config.DISABLE_RULES_HEADER];
  }
  var socket = req.socket || '';
  if (socket.fromTunnel) {
    req.fromTunnel = true;
  }
  if (clientInfo) {
    delete req.headers[config.CLIENT_INFO_HEAD];
    clientInfo = String(clientInfo).split(',');
    if (!net.isIP(clientInfo[0]) || !(clientInfo[1] > 0)) {
      return '';
    }
    req.fromTunnel = true;
    socket.fromTunnel = true;
  }
  return clientInfo;
};

function getCipher(rules) {
  var cipher = rules && getMatcherValue(rules.cipher);
  if (!cipher) {
    return TLSV2_CIPHERS;
  }
  cipher = cipher.toUpperCase();
  return CIPHER_OPTIONS.indexOf(cipher) === -1 ? TLSV2_CIPHERS : cipher;
}

exports.getCipher = getCipher;

exports.connect = function (options, callback) {
  var socket, timer, done, retry;
  var execCallback = function (err) {
    clearTimeout(timer);
    timer = null;
    if (!done) {
      done = true;
      err ? callback(err) : callback(null, socket);
    }
  };
  var handleConnect = function () {
    execCallback();
  };
  var handleError = function (err) {
    if (done) {
      return;
    }
    socket.removeAllListeners();
    socket.on('error', noop);
    socket.destroy(err);
    clearTimeout(timer);
    if (retry) {
      return execCallback(err);
    }
    retry = true;
    timer = setTimeout(handleTimeout, 12000);
    try {
      if (options.ALPNProtocols && err && isCiphersError(err)) {
        options.ciphers = getCipher(options._rules);
      }
      socket = sockMgr.connect(options, handleConnect);
    } catch (e) {
      return execCallback(e);
    }
    socket.on('error', handleError);
    socket.on('close', function (err) {
      !done && execCallback(err || new Error('closed'));
    });
  };
  var handleTimeout = function () {
    handleError(TIMEOUT_ERR);
  };
  var sockMgr = options.ALPNProtocols ? tls : net;
  timer = setTimeout(handleTimeout, 6000);
  try {
    socket = sockMgr.connect(options, handleConnect);
  } catch (e) {
    return execCallback(e);
  }
  socket.on('error', handleError);
};

exports.checkPluginReqOnce = function (req, raw) {
  var isPluginReq = req.headers[config.PROXY_ID_HEADER];
  if (raw ? isPluginReq : isPluginReq == 1) {
    delete req.headers[config.PROXY_ID_HEADER];
  }
  req._isPureInternalReq = isPluginReq == 'internal';
  if (req._isPureInternalReq || isPluginReq == 'internalx') {
    req._isInternalReq = true;
    delete req.headers[config.PROXY_ID_HEADER];
  }
  return isPluginReq;
};

exports.showPluginReq = function(req) {
  return !req.isPluginReq || config.showPluginReq;
};

exports.checkPort = function (port, host, cb) {
  if (typeof host !== 'string') {
    cb = host;
    host = '127.0.0.1';
  }
  if (!port) {
    return cb();
  }
  var server = http.createServer();
  server.listen(port, host, function () {
    server.close(cb);
  });
};

var boundIpDeferMap = {};
exports.getBoundIp = function (host, cb) {
  if (typeof host === 'function') {
    cb = host;
    host = null;
  }
  host = host || config.defaultHost;
  if (!host || net.isIP(host)) {
    return cb(host);
  }
  var boundIpDefer = boundIpDeferMap[host];
  if (boundIpDefer) {
    return boundIpDefer.then(cb);
  }
  boundIpDeferMap[host] = boundIpDefer = new Promise(function(resolve) {
    dns.lookup(host, function (err, ip) {
      if (err) {
        throw err;
      }
      resolve(ip);
    });
  });
  boundIpDefer.then(cb);
};

function getPluginConfig(conf, name) {
  var result;
  if (conf != null) {
    try {
      result = JSON.stringify(conf);
    } catch (e) {}
  }
  return (
    '<script>window.' +
    (name || 'whistleMenuConfig') +
    ' = ' +
    (result || '{}') +
    ';</script>'
  );
}

exports.getPluginMenuConfig = function (conf) {
  return getPluginConfig(conf.menuConfig);
};

exports.getPluginInspectorConfig = function (conf) {
  return getPluginConfig(conf.inspectorConfig, 'whistleInspectorConfig');
};

function isIllegalcHeader(name, value) {
  switch (name) {
  case h2Consts.HTTP2_HEADER_CONNECTION:
  case h2Consts.HTTP2_HEADER_UPGRADE:
  case h2Consts.HTTP2_HEADER_HOST:
  case h2Consts.HTTP2_HEADER_HTTP2_SETTINGS:
  case h2Consts.HTTP2_HEADER_KEEP_ALIVE:
  case h2Consts.HTTP2_HEADER_PROXY_CONNECTION:
  case h2Consts.HTTP2_HEADER_TRANSFER_ENCODING:
    return true;
  case h2Consts.HTTP2_HEADER_TE:
    return value !== 'trailers';
  default:
    return false;
  }
}

exports.formatH2Headers = function (headers) {
  var newHeaders = {};
  Object.keys(headers).forEach(function (name) {
    var value = headers[name];
    if (!isIllegalcHeader(name, value)) {
      newHeaders[name] = value;
    }
  });
  return newHeaders;
};

function getProp(obj, key, def) {
  key = key.split('.');
  for (var i = 0; i < key.length; i++) {
    obj = obj ? obj[key[i]] : undefined;
  }
  return obj == null ? def : obj;
}

var PLUGIN_VAR_RE =
  /\{\{(?:whistlePluginName|whistlePluginPackage\.([^}\s]+))\}\}/g;

exports.renderPluginRules = function (rules, pkg, simpleName) {
  return (
    rules &&
    rules.replace(PLUGIN_VAR_RE, function (_, key) {
      return key ? getProp(pkg, key, '') : simpleName;
    })
  );
};

exports.setClientCert = function (options, key, cert, isPfx, cacheKey) {
  if (!cert) {
    return;
  }
  options.cacheKey = cacheKey;
  if (isPfx) {
    options.pfx = cert;
    if (key) {
      options.passphrase = key;
    }
  } else {
    options.key = key;
    options.cert = cert;
  }
};

function isDisableUserLogin(rule, req) {
  if (rule.lineProps.enableUserLogin || (req && req.enable && req.enable.userLogin)) {
    return false;
  }
  return rule.lineProps.disableUserLogin || (req && req.disable && req.disable.userLogin);
}

exports.isDisableUserLogin = isDisableUserLogin;

exports.getStatusCodeFromRule = function (rules, req) {
  var rule = rules.rule;
  var isSpec = rule && rule.isSpec;
  if (!isSpec) {
    return;
  }
  var disableUserLogin = isDisableUserLogin(rule, req);
  rule = getMatcherValue(rule) || '';
  var isRedirect = isSpec === 2;
  if (req && isRedirect && rule && compareUrl(rule, req.fullUrl)) {
    req.isWebProtocol = true;
    req.options = parseUrl(req.fullUrl);
    return;
  }
  var code = rule || 200;
  var result = { statusCode: code, headers: {} };
  if (isRedirect) {
    result.statusCode = 302;
    result.headers.location = rule;
  } else  if (!disableUserLogin) {
    handleStatusCode(code, result.headers);
  }
  return result;
};

var GZIP_RE = /\bgzip\b/i;

exports.canGzip = function (req) {
  return GZIP_RE.test(req.headers['accept-encoding']);
};

function removeBody(req, data, isRes) {
  var rule = req['delete'] || '';
  if (rule.body || rule[isRes ? 'res.body' : 'req.body']) {
    delete data.top;
    delete data.bottom;
    data.body = EMPTY_BUFFER;
  }
}

exports.removeReqBody = function (req, data) {
  removeBody(req, data);
};

exports.removeResBody = function (req, data) {
  removeBody(req, data, true);
};

function readOneChunk(stream, callback, timeout) {
  if (!stream) {
    return callback();
  }
  var timer;
  var handler = function (chunk) {
    timer && clearTimeout(timer);
    stream.pause();
    stream.removeListener('data', handler);
    stream.removeListener('end', handler);
    callback(chunk);
  };
  if (timeout > 0) {
    timer = setTimeout(handler, timeout);
  }
  stream.on('data', handler);
  stream.on('end', handler);
}

exports.readOneChunk = readOneChunk;

exports.getAuthByRules = function (rules) {
  if (!rules.auth) {
    return;
  }
  var auth = getMatcherValue(rules.auth);
  if (/[\\\/]/.test(auth)) {
    return;
  }
  var index = auth.indexOf(':');
  return {
    username: index == -1 ? auth : auth.substring(0, index),
    password: index == -1 ? null : auth.substring(index + 1)
  };
};

exports.getAuthBasic = function (auth) {
  if (!auth) {
    return;
  }
  var basic;
  if (auth.username == null) {
    if (auth.password == null) {
      return;
    }
    basic = [''];
  } else {
    basic = [auth.username];
  }
  if (auth.password != null) {
    basic[1] = auth.password;
  }
  return basic && 'Basic ' + toBuffer(basic.join(':')).toString('base64');
};

exports.delay = function (time, callback) {
  if (time > 0) {
    setTimeout(callback, time);
  } else {
    callback();
  }
};

var F_HOST_RE = /\bhost\b/i;
var F_PROTO_RE = /\bproto\b/i;
var F_IP_RE = /\b(?:clientIp|ip|for)\b/i;

exports.handleForwardedProps = function (req) {
  var headers = req.headers;
  var props = headers['x-whistle-forwarded-props'];
  var enableFwdHost = config.enableFwdHost;
  var enableFwdProto = config.enableFwdProto;
  var enableFwdFor = config.keepXFF;
  if (props != null) {
    enableFwdHost = enableFwdHost || F_HOST_RE.test(props);
    enableFwdProto = enableFwdProto || F_PROTO_RE.test(props);
    enableFwdFor = enableFwdFor || F_IP_RE.test(props);
    if (config.master && enableFwdFor) {
      headers['x-whistle-forwarded-props'] = 'ip';
    } else {
      delete headers['x-whistle-forwarded-props'];
    }
  }
  req.enableXFF = enableFwdFor;
  if (enableFwdHost) {
    var host = headers[config.FWD_HOST_HEADER];
    if (host) {
      delete headers[config.FWD_HOST_HEADER];
      headers[config.REAL_HOST_HEADER] =
        headers[config.REAL_HOST_HEADER] || host;
    }
  }
  if (enableFwdProto) {
    var proto = headers[config.HTTPS_PROTO_HEADER];
    if (proto) {
      delete headers[config.HTTPS_PROTO_HEADER];
      req.isHttps = proto === 'https';
    }
  }
};

exports.filterWeakRule = function (req) {
  var rule = req.rules && req.rules.rule;
  if (!rule) {
    return;
  }
  var proxy = req.rules.proxy;
  if ((!proxy || proxy.lineProps.proxyHostOnly) && !req.rules.host) {
    return;
  }
  if (rule.lineProps.weakRule || isEnable(req, 'weakRule')) {
    delete req.rules.rule;
  }
};

exports.setPluginMgr = function(p) {
  pluginMgr = p;
};


function setTunnelHeaders(headers, remoteData) {
  var tunnelFirst = remoteData.tunnelFirst;
  if (remoteData.clientId) {
    headers[config.CLIENT_ID_HEADER] = remoteData.clientId;
  }
  if (
      remoteData.proxyAuth &&
      (tunnelFirst || !headers['proxy-authorization'])
    ) {
    headers['proxy-authorization'] = remoteData.proxyAuth;
  }
  if (remoteData.tunnelData) {
    headers[config.TUNNEL_DATA_HEADER] = remoteData.tunnelData;
  }
  if (remoteData.sniPlugin) {
    headers[config.SNI_PLUGIN_HEADER] = remoteData.sniPlugin;
  }
  var tunnelHeaders = remoteData.headers;
  if (tunnelHeaders) {
    Object.keys(tunnelHeaders).forEach(function (key) {
      if (tunnelFirst || !headers[key]) {
        headers[key] = tunnelHeaders[key];
      }
    });
  }
}

exports.setTunnelHeaders = setTunnelHeaders;

var tunnelDataKey = config.TUNNEL_DATA_HEADER;
var tmplDataKey = config.TEMP_TUNNEL_DATA_HEADER;

exports.addTunnelData = function(socket, headers) {
  var data = socket[tunnelDataKey];
  if (!data) {
    data = headers[tmplDataKey];
    if (data) {
      delete headers[tmplDataKey];
      try {
        data = decodeURIComponent(data);
        data = JSON.parse(data);
        socket[tunnelDataKey] = data;
      } catch(e) {
        return;
      }
    }
  }
  data && setTunnelHeaders(headers, data);
};

function _isInternalProxy(rule) {
  return rule && rule.lineProps.internalProxy;
}

exports.isInternalProxy = function(req) {
  if (isEnable(req, 'internalProxy')) {
    return true;
  }
  var rules = req.rules || '';
  return _isInternalProxy(rules.proxy) || _isInternalProxy(rules.host);
};

var IP_RE = /^(\d{1,3}(?:\.\d{1,3}){3}|localhost|\[[^\]]+\])(?::\d+)$/;
function checkProxyHost(host, filter) {
  var result;
  if (filter.hostPattern) {
    result = filter.hostPattern.test(host);
  } else if (filter.host === '<local>') {
    if (IP_RE.test(host)) {
      host = RegExp.$1;
    }
    result = host === 'localhost' || isLocalAddress(host);
  } else if (filter.host) {
    if (filter.host.slice(-1) === ':') {
      result = !host.indexOf(filter.host);
    } else {
      result = host === filter.host;
    }
  }
  return filter.not ? !result : result;
}

exports.checkProxyHost = function(proxy, host) {
  var filters = proxy && proxy.hostFilter;
  if (filters) {
    if (!host) {
      return false;
    }
    var hasIncludeFilter;
    var include, exclude;
    for (var i = 0, len = filters.length; i < len; i++) {
      var filter = filters[i];
      hasIncludeFilter = hasIncludeFilter || filter.isInclude;
      if ((filter.isInclude ? !include : !exclude) && checkProxyHost(host, filter)) {
        if (filter.isInclude) {
          include = true;
        } else {
          exclude = true;
        }
      }
    }
    return hasIncludeFilter ? include && !exclude : !exclude;
  }
  return true;
};

exports.getInspectorTabs = function(conf) {
  return conf.inspectorsTabs || conf.inspectorsTab || conf.inspectorTabs || conf.inspectorTab || '';
};


var SPEC_PATH = '/_WHISTLE_5b6af7b9884e1165_/';

exports.removeSpecPath = function(req) {
  var specPath = config.SPEC_PATH || SPEC_PATH;
  if (req.url && req.url.indexOf(specPath) !== -1) {
    req.url = req.url.replace(specPath, '/');
  }
};

function getRulesText(req) {
  var rules = req.rules;
  var keys = rules && Object.keys(rules);
  if (!keys || !keys.length) {
    return;
  }
  return safeEncodeURIComponent(keys.map(function(key) {
    var rule = rules[key];
    return rule.rawPattern + ' ' + rule.rawMatcher;
  }).join('\n'));
}

exports.addMatchedRules = function(req, res) {
  var enable = req.enable || '';
  if (!enable || (res ? !isEnable(req, 'responseWithMatchedRules') : !isEnable(req, 'requestWithMatchedRules'))) {
    return;
  }
  var rules = getRulesText(req);
  if (rules) {
    var headers = res ? res.headers : req.headers;
    headers['x-whistle-matched-rules'] = rules;
  }
};

exports.needAbortReq = function(req) {
  var disable = req.disable;
  if (disable.abort || disable.abortReq) {
    return false;
  }
  if (req.enable.abort || req._filters.abort ||
    req.enable.abortReq || req._filters.abortReq) {
    return true;
  }
  return req.isTunnel && disable.tunnel;
};

exports.needAbortRes = function(req) {
  var disable = req.disable;
  if (disable.abort || disable.abortRes) {
    return false;
  }
  if (req.enable.abort || req._filters.abort ||
    req.enable.abortRes || req._filters.abortRes) {
    return true;
  }
  return req.isTunnel && disable.tunnel;
};

var SSE_RE = /^\s*text\/event-stream\s*;?/i;

exports.isSSE = function(res) {
  return SSE_RE.test(res.headers['content-type']);
};

exports.setCharset = function(headers, charset, removeType, removeCharset) {
  if (!charset && !removeType && !removeCharset) {
    return;
  }
  var type = headers['content-type'];
  type = typeof type == 'string' ? type.trim() : '';
  type = type.split(/\s*;\s*/);
  if (removeType) {
    type[0] = '';
  }
  if (removeCharset) {
    type = [type[0]];
  } else if (charset) {
    type[1] = 'charset=' + charset;
  }
  type = type.join('; ');
  if (type) {
    headers['content-type'] = type;
  } else {
    delete headers['content-type'];
  }
};

exports.getNewType = function(type, headers) {
  if (type.indexOf(';') === -1) {
    var curType = headers['content-type'];
    if (typeof curType == 'string' && curType.indexOf(';') !== -1) {
      curType = curType.split(';');
      curType[0] = type;
      type = curType.join(';');
    }
  }
  return type;
};

exports.setRejectUnauthorized = function (req, options) {
  if (req._isInternalReq && req.disable.rejectUnauthorized) {
    options.rejectUnauthorized = false;
  } else {
    options.rejectUnauthorized = config.rejectUnauthorized;
  }
  return options;
};
