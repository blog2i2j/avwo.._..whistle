require('./base-css.js');
require('../css/filter-input.css');
var util = require('./util');
var React = require('react');
var ReactDOM = require('react-dom');
var $ = require('jquery');
var storage = require('./storage');
var win = require('./win');

var MAX_LEN = 128;
var FilterInput = React.createClass({
  getInitialState: function () {
    var hintKey = this.props.hintKey;
    this.allHintList = [];
    if (hintKey) {
      try {
        var hintList = JSON.parse(storage.get(hintKey));
        if (Array.isArray(hintList)) {
          var map = {};
          this.allHintList = hintList
            .map(function (key) {
              return typeof key === 'string' ? key.substring(0, MAX_LEN) : null;
            })
            .filter(function (key) {
              if (!key || map[key]) {
                return false;
              }
              map[key] = 1;
              return true;
            })
            .slice(0, MAX_LEN);
        }
      } catch (e) {}
    }
    return { hintList: [] };
  },
  componentDidMount: function () {
    var self = this;
    self.hintElem = $(ReactDOM.findDOMNode(this.refs.hints));
    $(document.body).on('mousedown', function(e) {
      if (self.state.hintList !== null && !$(e.target).closest('.w-filter-con').length) {
        self.hideHints();
      }
    });
  },
  focus: function() {
    var input = ReactDOM.findDOMNode(this.refs.input);
    input.select();
    input.focus();
  },
  addHint: function () {
    var value = this.state.filterText;
    value = value && value.trim();
    if (value) {
      var list = this.allHintList;
      var index = list.indexOf(value);
      if (index !== -1) {
        list.splice(index, 1);
      }
      if (list.length > MAX_LEN) {
        list.splice(0, 1);
      }
      list.push(value);
      try {
        storage.set(this.props.hintKey, JSON.stringify(list));
      } catch (e) {}
    }
  },
  filterHints: function (keyword) {
    keyword = keyword && keyword.trim();
    var count = 10;
    var addonHints = this.props.addonHints || [];
    if (!keyword) {
      return addonHints.concat(this.allHintList.slice(-count));
    }
    addonHints = addonHints.slice(1);
    count += addonHints.length;
    var allHintList = addonHints.concat(this.allHintList);
    var list = [];
    var lk = keyword.toLowerCase();
    var notColon = keyword.indexOf(':') === -1;
    for (var i = allHintList.length - 1; i >= 0; i--) {
      var key = allHintList[i];
      if (key !== keyword && key.toLowerCase().indexOf(lk) !== -1 &&
      (addonHints.indexOf(key) === -1 || notColon)) {
        list.unshift(key);
        if (list.length >= count) {
          return list;
        }
      }
    }
    return list;
  },
  onFilterChange: function (e) {
    this.changeInput(e ? e.target.value : '');
  },
  changeInput: function (value) {
    var self = this;
    self.props.onChange && self.props.onChange(value);
    var hintKey = self.props.hintKey;
    hintKey && clearTimeout(self.timer);
    this.state.filterText = value;
    self.setState({ hintList: this.filterHints(value) }, function () {
      if (hintKey) {
        self.timer = setTimeout(this.addHint, 10000);
      }
    });
  },
  onClick: function (e) {
    this.changeInput(e.target.title);
    this.hideHints();
  },
  hideHints: function () {
    this.setState({ hintList: null });
    this.addHint();
  },
  showHints: function () {
    this.setState({ hintList: this.filterHints(this.state.filterText) });
  },
  onFilterKeyDown: function (e) {
    var elem;
    if (e.keyCode === 27) {
      var hintList = this.state.hintList;
      if (hintList === null) {
        this.showHints();
      } else {
        this.hideHints();
      }
    } else if (e.keyCode === 38) {
      // up
      elem = this.hintElem.find('.w-active');
      if (this.state.hintList === null) {
        this.showHints();
      }
      if (elem.length) {
        elem.removeClass('w-active');
        elem = elem.prev('li').addClass('w-active');
      }

      if (!elem.length) {
        elem = this.hintElem.find('li:last');
        elem.addClass('w-active');
      }
      util.ensureVisible(elem, this.hintElem);
      e.preventDefault();
    } else if (e.keyCode === 40) {
      // down
      elem = this.hintElem.find('.w-active');
      if (this.state.hintList === null) {
        this.showHints();
      }
      if (elem.length) {
        elem.removeClass('w-active');
        elem = elem.next('li').addClass('w-active');
      }

      if (!elem.length) {
        elem = this.hintElem.find('li:first');
        elem.addClass('w-active');
      }
      util.ensureVisible(elem, this.hintElem);
      e.preventDefault();
    } else if (e.keyCode === 13) {
      elem = this.hintElem.find('.w-active');
      var value = elem.attr('title');
      if (value) {
        this.changeInput(value);
        this.hideHints();
      }
    } else if (e.ctrlKey || e.metaKey) {
      if (e.keyCode == 68) {
        this.clearFilterText();
        e.preventDefault();
        e.stopPropagation();
      } else if (e.keyCode == 88) {
        e.stopPropagation();
      }
    }
    if (typeof this.props.onKeyDown === 'function') {
      this.props.onKeyDown(e);
    }
  },
  clear: function () {
    var self = this;
    win.confirm('Confirm to clear history?', function (sure) {
      if (sure) {
        storage.set(self.props.hintKey, '');
        self.allHintList = [];
        self.hideHints();
      }
    });
  },
  clearFilterText: function () {
    this.props.onChange && this.props.onChange('');
    var hintList = null;
    if (document.activeElement === ReactDOM.findDOMNode(this.refs.input)) {
      hintList = this.filterHints();
    }
    var hasChanged = this.state.filterText;
    var self = this;
    this.setState({ filterText: '', hintList: hintList }, function() {
      if (hasChanged) {
        self.onFilterChange();
      }
    });
  },
  render: function () {
    var self = this;
    var filterText = self.state.filterText || '';
    var hintKey = self.props.hintKey;
    var hintList = self.state.hintList;
    var addonHints = this.props.addonHints || [];

    return (
      <div className="w-filter-con" style={self.props.wStyle}>
        {hintKey ? (
          <div
            className="w-filter-hint"
            style={{ display: hintList && hintList.length ? '' : 'none' }}
            onMouseDown={util.preventBlur}
          >
            <div className="w-filter-bar">
              <a onClick={this.clear}>
                <span className="glyphicon glyphicon-trash"></span>
                Clear history
              </a>
              <span onClick={self.hideHints} aria-hidden="true">
                &times;
              </span>
            </div>
            <ul ref="hints">
              {hintList &&
                hintList.map(function (key) {
                  var title = key;
                  if (addonHints.indexOf(key) !== -1) {
                    title = key.substring(0, key.indexOf(':') + 1);
                  }
                  return (
                    <li key={key} onClick={self.onClick} title={title}>
                      {key}
                    </li>
                  );
                })}
            </ul>
          </div>
        ) : undefined}
        <input
          type="text"
          ref="input"
          value={filterText}
          onChange={self.onFilterChange}
          onKeyDown={self.onFilterKeyDown}
          onFocus={self.showHints}
          onDoubleClick={self.showHints}
          onBlur={self.hideHints}
          style={{ background: filterText.trim() ? '#000' : undefined }}
          className="w-filter-input"
          maxLength={MAX_LEN}
          placeholder={'Type filter text' + (this.props.placeholder || '')}
        />
        <button
          onMouseDown={util.preventBlur}
          onClick={self.clearFilterText}
          style={{ display: self.state.filterText ? 'block' : 'none' }}
          type="button"
          className="close"
          title="Ctrl[Command]+D"
        >
          <span aria-hidden="true">&times;</span>
        </button>
      </div>
    );
  }
});

module.exports = FilterInput;
