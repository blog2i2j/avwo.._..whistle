require('./base-css.js');
require('../css/req-detail.css');
var React = require('react');
var Divider = require('./divider');
var Properties = require('./properties');
var util = require('./util');
var BtnGroup = require('./btn-group');
var JSONViewer = require('./json-viewer');
var Textarea = require('./textarea');
var dataCenter = require('./data-center');
var PluginsTabs = require('./plugins-tabs');
var events = require('./events');

var BTNS = [
  { name: 'Headers' },
  { name: 'WebForms' },
  { name: 'TextView', display: 'Body' },
  { name: 'JSONView' },
  { name: 'HexView' },
  { name: 'Cookies' },
  { name: 'Raw' },
  { name: 'Plugins', hide: true }
];

var ReqDetail = React.createClass({
  getInitialState: function () {
    return {
      initedHeaders: false,
      initedTextView: false,
      initedCookies: false,
      initedWebForms: false,
      initedJSONView: false,
      initedHexView: false,
      initedRaw: false,
      initPlugins: false
    };
  },
  componentDidMount: function () {
    var self = this;
    events.on('reqTabsChange', function () {
      self.setState({});
    });
  },
  shouldComponentUpdate: function (nextProps) {
    var hide = util.getBoolean(this.props.hide);
    return hide != util.getBoolean(nextProps.hide) || !hide;
  },
  onClickBtn: function (btn) {
    this.selectBtn(btn);
    this.setState({});
  },
  selectBtn: function (btn) {
    btn.active = true;
    this.state.btn = btn;
    this.state['inited' + btn.name] = true;
  },
  render: function () {
    var state = this.state;
    var btn = state.btn;
    if (!btn) {
      btn = BTNS[0];
      this.selectBtn(btn);
    }
    var name = btn && btn.name;
    var modal = this.props.modal;
    var req,
      headers,
      headersStr,
      rawHeaders,
      cookies,
      body,
      raw,
      query,
      form,
      tips,
      json,
      defaultName,
      bin,
      base64;
    body = raw = '';
    if (modal) {
      req = modal.req;
      rawHeaders = req.rawHeaders;
      defaultName = util.getFilename(modal, true);
      body = util.getBody(req, true);
      bin = util.getHex(req);
      base64 = req.base64;
      headers = req.headers;
      json = util.getJson(req, true, decodeURIComponent);
      delete headers.Host;
      cookies = util.parseQueryString(
        headers.cookie,
        /;\s*/g,
        null,
        decodeURIComponent
      );
      var url = modal.url;
      var realUrl = modal.realUrl;
      if (!realUrl || !/^(?:http|wss)s?:\/\//.test(realUrl)) {
        realUrl = url;
      }
      var index = realUrl.indexOf('?');
      query = index == -1 ? '' : realUrl.substring(index + 1);
      query = query && util.parseQueryString(
        query,
        null,
        null,
        decodeURIComponent
      );
      if (util.isUrlEncoded(req)) {
        form = util.parseQueryString(
          util.getBody(req, true),
          null,
          null,
          decodeURIComponent
        );
        if (!window.___hasFormData) {
          form = null;
        }
      } else if (util.isUploadForm(req)) {
        form = util.parseUploadBody(req, true);
      } else if (json && json.isJSONText) {
        form = json;
      }
      headersStr = util.objectToString(headers, req.rawHeaderNames);
      headersStr =
        [
          req.method,
          req.method == 'CONNECT' ? headers.host : util.getPath(realUrl),
          'HTTP/' + (req.httpVersion || '1.1')
        ].join(' ') +
        '\r\n' +
        headersStr;
      raw = headersStr + '\r\n\r\n' + body;
      if (modal.frames) {
        tips = { isFrames: true };
      } else if (modal.isHttps) {
        tips = { isHttps: true };
      } else if (
        modal.requestTime &&
        modal.useFrames !== false &&
        !body &&
        !/^ws/.test(modal.url)
      ) {
        if (req.size < 5120) {
          tips = { message: 'Empty request body' };
        } else {
          raw += '(Request body exceeds display limit)';
          tips = { message: 'Request body exceeds display limit' };
        }
      }
    }
    state.raw = raw;
    state.body = body;
    base64 = base64 || '';
    var pluginsTab = BTNS[7];
    var tabs = dataCenter.getReqTabs();
    var len = tabs.length;
    pluginsTab.display = undefined;
    pluginsTab.title = undefined;
    pluginsTab.className = undefined;
    pluginsTab.hide = !len;
    if (len && len === 1) {
      pluginsTab.display = pluginsTab.title = tabs[0].name;
      pluginsTab.className = 'w-detail-custom-tab w-req';
    } else {
      pluginsTab.display = undefined;
      pluginsTab.title = undefined;
      pluginsTab.className = undefined;
    }

    return (
      <div
        className={
          'fill orient-vertical-box w-detail-content w-detail-request' +
          (util.getBoolean(this.props.hide) ? ' hide' : '')
        }
      >
        <BtnGroup onClick={this.onClickBtn} btns={BTNS} />
        {state.initedHeaders ? (
          <div
            className={
              'fill w-detail-request-headers' +
              (name == BTNS[0].name ? '' : ' hide')
            }
          >
            <Properties modal={rawHeaders || headers} enableViewSource="1" />
          </div>
        ) : (
          ''
        )}
        {state.initedWebForms ? (
          <Divider
            vertical="true"
            hideRight={!form}
            hideLeft={!query}
            splitRatio={0.6}
            className={
              'w-detail-request-webforms' +
              (name == BTNS[1].name ? '' : ' hide')
            }
          >
            <div className="fill orient-vertical-box">
              <div className="w-detail-webforms-title">Query</div>
              <div className="fill orient-vertical-box w-detail-request-query">
                <Properties modal={query} enableViewSource="1" showJsonView="1" />
              </div>
            </div>
            <div className="fill orient-vertical-box">
              <div className="w-detail-webforms-title">Body</div>
              <div className="fill orient-vertical-box w-detail-request-form">
                {!json || !json.isJSONText ? <Properties modal={form} richKey="1" enableViewSource="1" showJsonView="1" /> :
                <JSONViewer reqData={modal} data={json} />}
              </div>
            </div>
          </Divider>
        ) : (
          ''
        )}
        {state.initedTextView ? (
          <Textarea
            reqData={modal}
            reqType="reqBody"
            defaultName={defaultName}
            tips={tips}
            base64={base64}
            value={body}
            className="fill w-detail-request-textview"
            hide={name != BTNS[2].name}
          />
        ) : undefined}
        {state.initedJSONView ? (
          <JSONViewer
            reqData={modal}
            reqType="reqRaw"
            defaultName={defaultName}
            data={json}
            tips={tips}
            hide={name != BTNS[3].name}
          />
        ) : undefined}
        {state.initedHexView ? (
          <Textarea
            reqData={modal}
            reqType="reqBody"
            defaultName={defaultName}
            tips={tips}
            isHexView="1"
            base64={base64}
            value={bin}
            className="fill n-monospace w-detail-request-hex"
            hide={name != BTNS[4].name}
          />
        ) : undefined}
        {state.initedCookies ? (
          <div
            className={
              'fill w-detail-request-cookies' +
              (name == BTNS[5].name ? '' : ' hide')
            }
          >
            <Properties modal={cookies} enableViewSource="1" />
          </div>
        ) : undefined}
        {state.initedRaw ? (
          <Textarea
            reqData={modal}
            reqType="reqRaw"
            defaultName={defaultName}
            value={raw}
            headers={headersStr}
            base64={base64}
            className="fill w-detail-request-raw"
            hide={name != BTNS[6].name}
          />
        ) : undefined}
        {state.initedPlugins ? (
          <PluginsTabs
            tabs={tabs}
            hide={name != pluginsTab.name || pluginsTab.hide}
          />
        ) : undefined}
      </div>
    );
  }
});

module.exports = ReqDetail;
