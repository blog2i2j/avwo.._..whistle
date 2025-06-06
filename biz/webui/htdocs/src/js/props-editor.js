require('./base-css.js');
require('../css/props-editor.css');
var React = require('react');
var ReactDOM = require('react-dom');
var Dialog = require('./dialog');
var util = require('./util');
var message = require('./message');
var win = require('./win');
var ContextMenu = require('./context-menu');

var MAX_FILE_SIZE = 1024 * 1024 * 20;
var MAX_NAME_LEN = 128;
var MAX_VALUE_LEN = 64 * 1024;
var MAX_COUNT = 160;
var index = MAX_COUNT;
var W2_HEADER_RE = /^x-whistle-/;

var highlight = function (name) {
  return name === 'x-forwarded-for' || W2_HEADER_RE.test(name);
};
var PropsEditor = React.createClass({
  getInitialState: function () {
    return {};
  },
  getValue: function (name, field) {
    var isHeader = this.props.isHeader;
    var allowUploadFile = this.props.allowUploadFile;
    var decode = isHeader ? util.decodeURIComponentSafe : util.noop;
    var shortName = decode(name.substring(0, MAX_NAME_LEN), isHeader);
    var result = { name: shortName };
    if (allowUploadFile && field && field.value != null) {
      result.value = decode(
        util.toString(field.value).substring(0, MAX_VALUE_LEN),
        isHeader
      );
      result.data = field.data;
      result.size = (field.data && field.data.length) || 0;
      result.type = field.type;
    } else {
      result.value = decode(
        util.toString(field).substring(0, MAX_VALUE_LEN),
        isHeader
      );
    }
    return result;
  },
  update: function (data) {
    var modal = {};
    var overflow;
    if (data) {
      var self = this;
      var keys = Object.keys(data);
      overflow = keys.length >= MAX_COUNT;
      if (overflow) {
        keys = keys.slice(0, MAX_COUNT);
      }
      keys.forEach(function (name) {
        var value = data[name];
        if (!Array.isArray(value)) {
          modal[name + '_0'] = self.getValue(name, value);
          return;
        }
        value.forEach(function (val, i) {
          modal[name + '_' + i] = self.getValue(name, val);
        });
      });
    }
    this.setState({ modal: modal }, this.props.onUpdate);
    return overflow;
  },
  onAdd: function () {
    if (this.props.disabled) {
      return;
    }
    if (Object.keys(this.state.modal || '').length >= MAX_COUNT) {
      return message.error('Maximum allowed value: ' + MAX_COUNT);
    }
    this.setState({ data: '' });
    this.showDialog();
  },
  clear: function() {
    if (!Object.keys(this.state.modal || '').length) {
      return;
    }
    this.setState({ modal: {} }, this.props.onChange);
  },
  onEdit: function (e) {
    if (this.props.disabled) {
      return;
    }
    var name = e.target.getAttribute('data-name');
    var data = this.state.modal[name];
    this.setState({ data: data });
    this.showDialog(data);
  },
  execCallback: function(e) {
    if (e.target.getAttribute('data-action') === 'callback') {
      this.props.callback();
    }
  },
  edit: function (e) {
    var nameInput = ReactDOM.findDOMNode(this.refs.name);
    var name = nameInput.value.trim();
    if (!name) {
      nameInput.focus();
      return message.error('The name is required');
    }
    var valueInput = ReactDOM.findDOMNode(this.refs.valueInput);
    var value = valueInput.value.trim();
    var state = this.state;
    var data = state.data;
    var origName = data.name;
    data.name = name;
    data.data = state.fileData;
    if (state.fileData) {
      data.size = state.fileSize;
      data.value = state.filename;
      data.type = state.fileType;
    } else {
      data.value = value;
    }
    this.props.onChange(origName, name);
    this.setState({
      fileData: null,
      fileSize: null,
      filename: null,
      fileType: null
    });
    this.hideDialog();
    nameInput.value = valueInput.value = '';
    this.execCallback(e);
  },
  add: function (e) {
    var nameInput = ReactDOM.findDOMNode(this.refs.name);
    var name = nameInput.value.trim();
    if (!name) {
      nameInput.focus();
      return message.error('The name is required');
    }
    var valueInput = ReactDOM.findDOMNode(this.refs.valueInput);
    var value = valueInput.value.trim();
    var modal = this.state.modal;
    var state = this.state;
    if (!modal) {
      modal = {};
      state.modal = modal;
    }
    modal[name + '_' + ++index] = state.fileData
      ? {
        name: name,
        value: state.filename,
        size: state.fileSize,
        data: state.fileData,
        type: state.fileType
      }
      : {
        name: name,
        value: value
      };
    this.props.onChange(name);
    this.setState({
      fileData: null,
      fileSize: null,
      filename: null,
      fileType: null
    });
    this.hideDialog();
    nameInput.value = valueInput.value = '';
    this.execCallback(e);
  },
  hideDialog: function () {
    this.refs.composerDialog.hide();
  },
  showDialog: function (data) {
    this.refs.composerDialog.show();
    var nameInput = ReactDOM.findDOMNode(this.refs.name);
    if (data) {
      nameInput.value = data.name || '';
      if (data.data) {
        this.setState({
          filename: data.value,
          fileSize: data.size,
          fileData: data.data,
          fileType: data.type
        });
      } else {
        ReactDOM.findDOMNode(this.refs.valueInput).value = data.value || '';
      }
    }
    setTimeout(function () {
      nameInput.select();
      nameInput.focus();
    }, 600);
  },
  onRemove: function (e) {
    var self = this;
    if (self.props.disabled) {
      return;
    }
    var name = e.target.getAttribute('data-name');
    var opName = self.props.isHeader ? 'header' : 'param';
    var item = self.state.modal[name];
    win.confirm(
      'Do you confirm the deletion of this ' + opName + ' \'' + item.name + '\'?',
      function (sure) {
        if (sure) {
          delete self.state.modal[name];
          self.props.onChange(item.name);
          self.setState({});
        }
      }
    );
  },
  getFields: function () {
    var modal = this.state.modal || '';
    return Object.keys(modal).map(function (key) {
      return modal[key];
    });
  },
  toString: function () {
    var modal = this.state.modal || '';
    var keys = Object.keys(modal);
    if (this.props.isHeader) {
      return keys
        .map(function (key) {
          var obj = modal[key];
          return obj.name + ': ' + util.encodeNonLatin1Char(obj.value);
        })
        .join('\r\n');
    }
    return keys
      .map(function (key) {
        var obj = modal[key];
        return (
          util.encodeURIComponent(obj.name) +
          '=' +
          util.encodeURIComponent(obj.value)
        );
      })
      .join('&');
  },
  onUpload: function () {
    if (!this.reading) {
      ReactDOM.findDOMNode(this.refs.readLocalFile).click();
    }
  },
  readLocalFile: function () {
    var form = new FormData(ReactDOM.findDOMNode(this.refs.readLocalFileForm));
    var file = form.get('localFile');
    if (file.size > MAX_FILE_SIZE) {
      return win.alert('Total file size must not exceed 20MB');
    }
    var modal = this.state.modal || '';
    var size = file.size;
    Object.keys(modal).forEach(function (key) {
      size += modal[key].size;
    });
    if (size > MAX_FILE_SIZE) {
      return win.alert('Total file size must not exceed 20MB');
    }
    var self = this;
    self.reading = true;
    util.readFile(file, function (data) {
      self.reading = false;
      self.localFileData = data;
      self.setState({
        filename: file.name || 'unknown',
        fileData: data,
        fileSize: file.size,
        fileType: file.type
      });
    });
    ReactDOM.findDOMNode(this.refs.readLocalFile).value = '';
  },
  removeLocalFile: function (e) {
    var self = this;
    self.setState(
      {
        filename: null,
        fileData: null
      },
      function () {
        var valueInput = ReactDOM.findDOMNode(self.refs.valueInput);
        valueInput.select();
        valueInput.focus();
      }
    );
    e.stopPropagation();
  },
  onContextMenu: function(e) {
    util.handlePropsContextMenu(e, this.refs.contextMenu);
  },
  render: function () {
    var self = this;
    var modal = this.state.modal || '';
    var filename = this.state.filename;
    var fileSize = this.state.fileSize;
    var keys = Object.keys(modal);
    var isHeader = this.props.isHeader;
    var allowUploadFile = this.props.allowUploadFile;
    var data = this.state.data || '';
    var text = data ? 'Modify' : 'Add';
    var btnText = text + (isHeader ? ' Header' : ' Param');
    var cbBtnText = this.props.callback ? text + ' & Send' : null;

    return (
      <div
        className={
          'fill orient-vertical-box w-props-editor' +
          (this.props.hide ? ' hide' : '')
        }
        title={this.props.title}
        onDoubleClick={this.props.onDoubleClick}
      >
        {keys.length ? (
          <table className="table">
            <tbody onContextMenu={this.onContextMenu}>
              {keys.map(function (name) {
                var item = modal[name];
                return (
                  <tr key={name} data-name={item.name} data-value={item.value}>
                    <th
                      className={
                        isHeader && highlight(item.name) ? 'w-bold' : undefined
                      }
                    >
                      {item.name}
                    </th>
                    <td>
                      <pre>
                        {item.data ? (
                          <span className="glyphicon glyphicon-file"></span>
                        ) : undefined}
                        {item.data
                          ? ' [' + util.getSize(item.size) + '] '
                          : undefined}
                        {item.value}
                      </pre>
                    </td>
                    <td className="w-props-ops">
                      <a
                        data-name={name}
                        onClick={self.onEdit}
                        className="glyphicon glyphicon-edit"
                        title="Edit"
                      ></a>
                      <a
                        data-name={name}
                        onClick={self.onRemove}
                        className="glyphicon glyphicon-remove"
                        title="Delete"
                      ></a>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        ) : (
          <button
            onClick={this.onAdd}
            disabled={this.props.disabled}
            className={
              'btn btn-primary btn-sm w-add-field' +
              (this.props.isHeader ? ' w-add-header' : '')
            }
          >
            {this.props.isHeader ? '+Header' : '+Param'}
          </button>
        )}
        <Dialog ref="composerDialog" wstyle="w-composer-dialog">
          <div className="modal-body">
            <button type="button" className="close" data-dismiss="modal">
              <span aria-hidden="true">&times;</span>
            </button>
            <label>
              Name:
              <input
                ref="name"
                placeholder="Enter name"
                className="form-control"
                maxLength="128"
              />
            </label>
            <div>
              Value:
              <div
                className={
                  allowUploadFile
                    ? 'w-props-editor-upload'
                    : 'w-props-editor-form'
                }
              >
                <div
                  onClick={this.onUpload}
                  className={'w-props-editor-file' + (filename ? '' : ' hide')}
                  title={filename}
                >
                  <button
                    onClick={this.removeLocalFile}
                    type="button"
                    className="close"
                    title="Remove file"
                  >
                    <span aria-hidden="true">&times;</span>
                  </button>
                  <span className="glyphicon glyphicon-file"></span>
                  {' [' + util.getSize(fileSize) + '] '}
                  {filename}
                </div>
                <textarea
                  ref="valueInput"
                  maxLength={MAX_VALUE_LEN}
                  placeholder="Enter value"
                  className={'form-control' + (filename ? ' hide' : '')}
                  onKeyDown={util.handleTab}
                />
                <button
                  onClick={this.onUpload}
                  className={'btn btn-primary' + (filename ? ' hide' : '')}
                >
                  <span className="glyphicon glyphicon-folder-open" />
                  Upload
                </button>
              </div>
            </div>
          </div>
          <div className="modal-footer">
            <button
              type="button"
              className="btn btn-default"
              data-dismiss="modal"
            >
              Cancel
            </button>
            {
              cbBtnText ?
              <button
                type="button"
                className="btn btn-default"
                data-action="callback"
                onClick={data ? self.edit : self.add}
              >
                {cbBtnText}
              </button> : null
            }
            <button
              type="button"
              className="btn btn-primary"
              onClick={data ? self.edit : self.add}
            >
              {btnText}
            </button>
          </div>
        </Dialog>
        <form
          ref="readLocalFileForm"
          encType="multipart/form-data"
          style={{ display: 'none' }}
        >
          <input
            ref="readLocalFile"
            onChange={this.readLocalFile}
            type="file"
            name="localFile"
          />
        </form>
        <ContextMenu ref="contextMenu" />
      </div>
    );
  }
});

module.exports = PropsEditor;
