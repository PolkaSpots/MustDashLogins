/*!
 * mustache.js - Logic-less {{mustache}} templates with JavaScript
 * http://github.com/janl/mustache.js
 */

/*global define: false*/

var Mustache;

(function (exports) {
  if (typeof module !== "undefined" && module.exports) {
    module.exports = exports; // CommonJS
  } else if (typeof define === "function") {
    define(exports); // AMD
  } else {
    Mustache = exports; // <script>
  }
}((function () {

  var exports = {};

  exports.name = "mustache.js";
  exports.version = "0.7.0";
  exports.tags = ["{{", "}}"];

  exports.Scanner = Scanner;
  exports.Context = Context;
  exports.Writer = Writer;

  var whiteRe = /\s*/;
  var spaceRe = /\s+/;
  var nonSpaceRe = /\S/;
  var eqRe = /\s*=/;
  var curlyRe = /\s*\}/;
  var tagRe = /#|\^|\/|>|\{|&|=|!/;

  // Workaround for https://issues.apache.org/jira/browse/COUCHDB-577
  // See https://github.com/janl/mustache.js/issues/189
  function testRe(re, string) {
    return RegExp.prototype.test.call(re, string);
  }

  function isWhitespace(string) {
    return !testRe(nonSpaceRe, string);
  }

  var isArray = Array.isArray || function (obj) {
    return Object.prototype.toString.call(obj) === "[object Array]";
  };

  function escapeRe(string) {
    return string.replace(/[\-\[\]{}()*+?.,\\\^$|#\s]/g, "\\$&");
  }

  var entityMap = {
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': '&quot;',
    "'": '&#39;',
    "/": '&#x2F;'
  };

  function escapeHtml(string) {
    return String(string).replace(/[&<>"'\/]/g, function (s) {
      return entityMap[s];
    });
  }

  // Export the escaping function so that the user may override it.
  // See https://github.com/janl/mustache.js/issues/244
  exports.escape = escapeHtml;

  function Scanner(string) {
    this.string = string;
    this.tail = string;
    this.pos = 0;
  }

  /**
   * Returns `true` if the tail is empty (end of string).
   */
  Scanner.prototype.eos = function () {
    return this.tail === "";
  };

  /**
   * Tries to match the given regular expression at the current position.
   * Returns the matched text if it can match, the empty string otherwise.
   */
  Scanner.prototype.scan = function (re) {
    var match = this.tail.match(re);

    if (match && match.index === 0) {
      this.tail = this.tail.substring(match[0].length);
      this.pos += match[0].length;
      return match[0];
    }

    return "";
  };

  /**
   * Skips all text until the given regular expression can be matched. Returns
   * the skipped string, which is the entire tail if no match can be made.
   */
  Scanner.prototype.scanUntil = function (re) {
    var match, pos = this.tail.search(re);

    switch (pos) {
    case -1:
      match = this.tail;
      this.pos += this.tail.length;
      this.tail = "";
      break;
    case 0:
      match = "";
      break;
    default:
      match = this.tail.substring(0, pos);
      this.tail = this.tail.substring(pos);
      this.pos += pos;
    }

    return match;
  };

  function Context(view, parent) {
    this.view = view;
    this.parent = parent;
    this.clearCache();
  }

  Context.make = function (view) {
    return (view instanceof Context) ? view : new Context(view);
  };

  Context.prototype.clearCache = function () {
    this._cache = {};
  };

  Context.prototype.push = function (view) {
    return new Context(view, this);
  };

  Context.prototype.lookup = function (name) {
    var value = this._cache[name];

    if (!value) {
      if (name === ".") {
        value = this.view;
      } else {
        var context = this;

        while (context) {
          if (name.indexOf(".") > 0) {
            var names = name.split("."), i = 0;

            value = context.view;

            while (value && i < names.length) {
              value = value[names[i++]];
            }
          } else {
            value = context.view[name];
          }

          if (value != null) {
            break;
          }

          context = context.parent;
        }
      }

      this._cache[name] = value;
    }

    if (typeof value === "function") {
      value = value.call(this.view);
    }

    return value;
  };

  function Writer() {
    this.clearCache();
  }

  Writer.prototype.clearCache = function () {
    this._cache = {};
    this._partialCache = {};
  };

  Writer.prototype.compile = function (template, tags) {
    var fn = this._cache[template];

    if (!fn) {
      var tokens = exports.parse(template, tags);
      fn = this._cache[template] = this.compileTokens(tokens, template);
    }

    return fn;
  };

  Writer.prototype.compilePartial = function (name, template, tags) {
    var fn = this.compile(template, tags);
    this._partialCache[name] = fn;
    return fn;
  };

  Writer.prototype.compileTokens = function (tokens, template) {
    var fn = compileTokens(tokens);
    var self = this;

    return function (view, partials) {
      if (partials) {
        if (typeof partials === "function") {
          self._loadPartial = partials;
        } else {
          for (var name in partials) {
            self.compilePartial(name, partials[name]);
          }
        }
      }

      return fn(self, Context.make(view), template);
    };
  };

  Writer.prototype.render = function (template, view, partials) {
    return this.compile(template)(view, partials);
  };

  Writer.prototype._section = function (name, context, text, callback) {
    var value = context.lookup(name);

    switch (typeof value) {
    case "object":
      if (isArray(value)) {
        var buffer = "";

        for (var i = 0, len = value.length; i < len; ++i) {
          buffer += callback(this, context.push(value[i]));
        }

        return buffer;
      }

      return value ? callback(this, context.push(value)) : "";
    case "function":
      var self = this;
      var scopedRender = function (template) {
        return self.render(template, context);
      };

      var result = value.call(context.view, text, scopedRender);
      return result != null ? result : "";
    default:
      if (value) {
        return callback(this, context);
      }
    }

    return "";
  };

  Writer.prototype._inverted = function (name, context, callback) {
    var value = context.lookup(name);

    // Use JavaScript's definition of falsy. Include empty arrays.
    // See https://github.com/janl/mustache.js/issues/186
    if (!value || (isArray(value) && value.length === 0)) {
      return callback(this, context);
    }

    return "";
  };

  Writer.prototype._partial = function (name, context) {
    if (!(name in this._partialCache) && this._loadPartial) {
      this.compilePartial(name, this._loadPartial(name));
    }

    var fn = this._partialCache[name];

    return fn ? fn(context) : "";
  };

  Writer.prototype._name = function (name, context) {
    var value = context.lookup(name);

    if (typeof value === "function") {
      value = value.call(context.view);
    }

    return (value == null) ? "" : String(value);
  };

  Writer.prototype._escaped = function (name, context) {
    return exports.escape(this._name(name, context));
  };

  /**
   * Calculates the bounds of the section represented by the given `token` in
   * the original template by drilling down into nested sections to find the
   * last token that is part of that section. Returns an array of [start, end].
   */
  function sectionBounds(token) {
    var start = token[3];
    var end = start;

    var tokens;
    while ((tokens = token[4]) && tokens.length) {
      token = tokens[tokens.length - 1];
      end = token[3];
    }

    return [start, end];
  }

  /**
   * Low-level function that compiles the given `tokens` into a function
   * that accepts three arguments: a Writer, a Context, and the template.
   */
  function compileTokens(tokens) {
    var subRenders = {};

    function subRender(i, tokens, template) {
      if (!subRenders[i]) {
        var fn = compileTokens(tokens);
        subRenders[i] = function (writer, context) {
          return fn(writer, context, template);
        };
      }

      return subRenders[i];
    }

    return function (writer, context, template) {
      var buffer = "";
      var token, sectionText;

      for (var i = 0, len = tokens.length; i < len; ++i) {
        token = tokens[i];

        switch (token[0]) {
        case "#":
          sectionText = template.slice.apply(template, sectionBounds(token));
          buffer += writer._section(token[1], context, sectionText, subRender(i, token[4], template));
          break;
        case "^":
          buffer += writer._inverted(token[1], context, subRender(i, token[4], template));
          break;
        case ">":
          buffer += writer._partial(token[1], context);
          break;
        case "&":
          buffer += writer._name(token[1], context);
          break;
        case "name":
          buffer += writer._escaped(token[1], context);
          break;
        case "text":
          buffer += token[1];
          break;
        }
      }

      return buffer;
    };
  }

  /**
   * Forms the given array of `tokens` into a nested tree structure where
   * tokens that represent a section have a fifth item: an array that contains
   * all tokens in that section.
   */
  function nestTokens(tokens) {
    var tree = [];
    var collector = tree;
    var sections = [];
    var token, section;

    for (var i = 0; i < tokens.length; ++i) {
      token = tokens[i];

      switch (token[0]) {
      case "#":
      case "^":
        token[4] = [];
        sections.push(token);
        collector.push(token);
        collector = token[4];
        break;
      case "/":
        if (sections.length === 0) {
          throw new Error("Unopened section: " + token[1]);
        }

        section = sections.pop();

        if (section[1] !== token[1]) {
          throw new Error("Unclosed section: " + section[1]);
        }

        if (sections.length > 0) {
          collector = sections[sections.length - 1][4];
        } else {
          collector = tree;
        }
        break;
      default:
        collector.push(token);
      }
    }

    // Make sure there were no open sections when we're done.
    section = sections.pop();

    if (section) {
      throw new Error("Unclosed section: " + section[1]);
    }

    return tree;
  }

  /**
   * Combines the values of consecutive text tokens in the given `tokens` array
   * to a single token.
   */
  function squashTokens(tokens) {
    var token, lastToken, squashedTokens = [];

    for (var i = 0; i < tokens.length; ++i) {
      token = tokens[i];

      if (lastToken && lastToken[0] === "text" && token[0] === "text") {
        lastToken[1] += token[1];
        lastToken[3] = token[3];
      } else {
        lastToken = token;
        squashedTokens.push(token);
      }
    }

    return squashedTokens; 
  }

  function escapeTags(tags) {
    if (tags.length !== 2) {
      throw new Error("Invalid tags: " + tags.join(" "));
    }

    return [
      new RegExp(escapeRe(tags[0]) + "\\s*"),
      new RegExp("\\s*" + escapeRe(tags[1]))
    ];
  }

  /**
   * Breaks up the given `template` string into a tree of token objects. If
   * `tags` is given here it must be an array with two string values: the
   * opening and closing tags used in the template (e.g. ["<%", "%>"]). Of
   * course, the default is to use mustaches (i.e. Mustache.tags).
   */
  exports.parse = function (template, tags) {
    tags = tags || exports.tags;

    var tagRes = escapeTags(tags);
    var scanner = new Scanner(template);

    var tokens = [],      // Buffer to hold the tokens
        spaces = [],      // Indices of whitespace tokens on the current line
        hasTag = false,   // Is there a {{tag}} on the current line?
        nonSpace = false; // Is there a non-space char on the current line?

    // Strips all whitespace tokens array for the current line
    // if there was a {{#tag}} on it and otherwise only space.
    function stripSpace() {
      if (hasTag && !nonSpace) {
        while (spaces.length) {
          tokens.splice(spaces.pop(), 1);
        }
      } else {
        spaces = [];
      }

      hasTag = false;
      nonSpace = false;
    }

    var start, type, value, chr;

    while (!scanner.eos()) {
      start = scanner.pos;
      value = scanner.scanUntil(tagRes[0]);

      if (value) {
        for (var i = 0, len = value.length; i < len; ++i) {
          chr = value.charAt(i);

          if (isWhitespace(chr)) {
            spaces.push(tokens.length);
          } else {
            nonSpace = true;
          }

          tokens.push(["text", chr, start, start + 1]);
          start += 1;

          if (chr === "\n") {
            stripSpace(); // Check for whitespace on the current line.
          }
        }
      }

      start = scanner.pos;

      // Match the opening tag.
      if (!scanner.scan(tagRes[0])) {
        break;
      }

      hasTag = true;
      type = scanner.scan(tagRe) || "name";

      // Skip any whitespace between tag and value.
      scanner.scan(whiteRe);

      // Extract the tag value.
      if (type === "=") {
        value = scanner.scanUntil(eqRe);
        scanner.scan(eqRe);
        scanner.scanUntil(tagRes[1]);
      } else if (type === "{") {
        var closeRe = new RegExp("\\s*" + escapeRe("}" + tags[1]));
        value = scanner.scanUntil(closeRe);
        scanner.scan(curlyRe);
        scanner.scanUntil(tagRes[1]);
        type = "&";
      } else {
        value = scanner.scanUntil(tagRes[1]);
      }

      // Match the closing tag.
      if (!scanner.scan(tagRes[1])) {
        throw new Error("Unclosed tag at " + scanner.pos);
      }

      tokens.push([type, value, start, scanner.pos]);

      if (type === "name" || type === "{" || type === "&") {
        nonSpace = true;
      }

      // Set the tags for the next time around.
      if (type === "=") {
        tags = value.split(spaceRe);
        tagRes = escapeTags(tags);
      }
    }

    tokens = squashTokens(tokens);

    return nestTokens(tokens);
  };

  // The high-level clearCache, compile, compilePartial, and render functions
  // use this default writer.
  var _writer = new Writer();

  /**
   * Clears all cached templates and partials in the default writer.
   */
  exports.clearCache = function () {
    return _writer.clearCache();
  };

  /**
   * Compiles the given `template` to a reusable function using the default
   * writer.
   */
  exports.compile = function (template, tags) {
    return _writer.compile(template, tags);
  };

  /**
   * Compiles the partial with the given `name` and `template` to a reusable
   * function using the default writer.
   */
  exports.compilePartial = function (name, template, tags) {
    return _writer.compilePartial(name, template, tags);
  };

  /**
   * Compiles the given array of tokens (the output of a parse) to a reusable
   * function using the default writer.
   */
  exports.compileTokens = function (tokens, template) {
    return _writer.compileTokens(tokens, template);
  };

  /**
   * Renders the `template` with the given `view` and `partials` using the
   * default writer.
   */
  exports.render = function (template, view, partials) {
    return _writer.render(template, view, partials);
  };

  // This is here for backwards compatibility with 0.4.x.
  exports.to_html = function (template, view, partials, send) {
    var result = exports.render(template, view, partials);

    if (typeof send === "function") {
      send(result);
    } else {
      return result;
    }
  };

  return exports;

}())));


/*!
 * jQuery Cookie Plugin v1.3.1
 * https://github.com/carhartl/jquery-cookie
 *
 * Copyright 2013 Klaus Hartl
 * Released under the MIT license
 */
(function (factory) {
	if (typeof define === 'function' && define.amd) {
		// AMD. Register as anonymous module.
		define(['jquery'], factory);
	} else {
		// Browser globals.
		factory(jQuery);
	}
}(function ($) {

	var pluses = /\+/g;

	function raw(s) {
		return s;
	}

	function decoded(s) {
		return decodeURIComponent(s.replace(pluses, ' '));
	}

	function converted(s) {
		if (s.indexOf('"') === 0) {
			// This is a quoted cookie as according to RFC2068, unescape
			s = s.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
		}
		try {
			return config.json ? JSON.parse(s) : s;
		} catch(er) {}
	}

	var config = $.cookie = function (key, value, options) {

		// write
		if (value !== undefined) {
			options = $.extend({}, config.defaults, options);

			if (typeof options.expires === 'number') {
				var days = options.expires, t = options.expires = new Date();
				t.setDate(t.getDate() + days);
			}

			value = config.json ? JSON.stringify(value) : String(value);

			return (document.cookie = [
				config.raw ? key : encodeURIComponent(key),
				'=',
				config.raw ? value : encodeURIComponent(value),
				options.expires ? '; expires=' + options.expires.toUTCString() : '', // use expires attribute, max-age is not supported by IE
				options.path    ? '; path=' + options.path : '',
				options.domain  ? '; domain=' + options.domain : '',
				options.secure  ? '; secure' : ''
			].join(''));
		}

		// read
		var decode = config.raw ? raw : decoded;
		var cookies = document.cookie.split('; ');
		var result = key ? undefined : {};
		for (var i = 0, l = cookies.length; i < l; i++) {
			var parts = cookies[i].split('=');
			var name = decode(parts.shift());
			var cookie = decode(parts.join('='));

			if (key && key === name) {
				result = converted(cookie);
				break;
			}

			if (!key) {
				result[name] = converted(cookie);
			}
		}

		return result;
	};

	config.defaults = {};

	$.removeCookie = function (key, options) {
		if ($.cookie(key) !== undefined) {
			// Must not alter options, thus extending a fresh object...
			$.cookie(key, '', $.extend({}, options, { expires: -1 }));
			return true;
		}
		return false;
	};

}));

/*!
 * PolkaSpots Magic Form Code Version 0.1
 * Use it, but don't but don't steal it or claim it's yours
 * If you like it, put our name on it. If you like it a lot
 * You should email simon@polkaspots.com
 *
 * Copyright 2012, PolkaSpots Limited
 * http://polkaspots.com
 *
 * Licensed under the MIT license:
 * http://creativecommons.org/licenses/MIT/
 * 
 */

function params(name) {
  return decodeURI(
    (RegExp(name + '=' + '(.+?)(&|$)').exec(location.search)||[,null])[1]
  );
}

function polkaSpots(auth,loc) {
 $location = loc
 $.ajax({
  url: 'https://api.polkaspots.com/api/v1/locations/logins.json',
  type: 'application/x-javascript',
  data: { 'customer_id' : auth, 'location_id' : loc, 'request_uri' : document.location.hostname, 'mac' : params('mac'), 'sms' : $.cookie("sms") },
  dataType: 'JSONP',
  
 beforeSend: function() {
	  $('head').append( '<link href="http://mustache.my-wifi.co/css/base.css" media="screen" rel="stylesheet" type="text/css" />' );
 		$('body').addClass('magic-loader');
    $('#polkaloader').html('<img src="http://mustache.my-wifi.co/images/ajax-loader.gif" alt=""><h1>Loading</h1><h2>(Squeezing the Internet into a very small space)</h2>');
    $('head').append( '<meta http-equiv="Cache-control" content="no-cache">' );
    $('head').append( '<meta http-equiv="Pragma" content="no-cache">' ); 
  },
  
  success: function(data) {
  $('#polkaloader').hide();
  $('body').removeClass('magic-loader');
  
  if (data.location.archived == true ) {
	  $('body').addClass('closed-for-business');
	}
  
  if (data.location.network ==  'Meraki') {
	  $pathname = decodeURIComponent(params('login_url'));
	  if (data.location.success_url == '' ) {
		  $success_url = decodeURIComponent(params('continue_url'));
		}
		else {
			$success_url = data.location.success_url
		}
	}
	else if ( data.location.network == 'PolkaSpots' ) {
		$pathname = '/login';
		$success_url = $success_url = data.location.success_url
	}
	
  var html = Mustache.to_html(data.form, 
   {
      challenge: params('challenge'),
      uamip: params('uamip'),
      uamport: params('uamport'),
      called: params('called'),
      mac: params('mac'),
      sessionid: params('sessionid'),
      ip: params('ip'),
      pathname: $pathname,
      username: data.username,
      password: data.password,
      newsletter: data.location.newsletter,
      success_url: $success_url,
      request_uri: data.request,
			unique_id: data.location.unique_id,
			registration_link: data.location.registration_link
      }
  );
  
  var lazy_template = "<h1>{{location_name}}</h1>{{{location_header}}}<p>{{{location_info}}}</p><p>{{{location_info_two}}}</p><p>{{{ location_address }}}</p><a href='http://{{{ location_website }}}'>{{{location_website}}}</a>";
  
  var ps_lazy = Mustache.to_html(lazy_template, 
   {
      location_name: data.location.name,
      location_header: data.location.header,
      location_info: data.location.information_one,
      location_info_two: data.location.information_two,
      location_address: data.location.address,
      location_website: data.location.website,
      }
  );
 
 var ps_name = Mustache.to_html("{{location_name}}", 
   {
      location_name: data.location.name,
      location_info: data.location.information_one,
      }
  );
 
 var ps_header = Mustache.to_html("{{{ location_header }}}", 
   {
      location_header: data.location.header,
      }
  );

 var ps_information = Mustache.to_html("{{{ location_information }}}", 
   {
      location_information: data.location.information_one,
      }
  );

 var ps_information_two = Mustache.to_html("{{{ location_information_two }}}", 
   {
      location_information_two: data.location.information_two,
      }
  );

 var ps_address = Mustache.to_html("{{{ location_address }}}", 
   {
      location_address: data.location.address,
      }
  );
  
 var ps_location_website = Mustache.to_html("{{{ location_website }}}", 
   {
      location_website: data.location.website,
      }
  );

  
	if (data.location.texture == 400) {
		$.supersized({
		  slides  :  	[ {image : 'https://s3.amazonaws.com/ps-wifi/backgrounds/' + data.location.id + '/large/'+ data.location.background +''} ]
		});
		} else if (data.location.texture == 0) {
		} else {
		$.supersized({
		  slides  :  	[ {image : 'http://mustache.my-wifi.co/images/textures/texture-' + data.location.texture +'.jpeg'} ]
		});
	}

	$('head').append((params('res') == 'login') ? '<meta http-equiv="refresh" content="0;url=http://' + params('uamip') + ':' + params('uamport') +'/?username=' + params('UserName') + '&password=' + params('Password') + '&userurl=' + params('UserName') + '\">'  :  '' );
	$('#polkaform').html(html);

	$('.polkaspots_logo').html(( data.location.remove_polkaspots == true ) ? '<a href="http://' + ps_location_website + '"><img src="https://s3.amazonaws.com/ps-wifi/logos/' + data.location.id +'/medium/'+ data.location.logo +'" alt="" class=" customer-logo"></a>' : '<a href="'+ data.wisp.website +'"><img src="'+ data.wisp.logo +'" alt="" class="polkaspots-logo"></a>' );

	$('#message').html(( data.message != null ) ? ('<h3>' + data.message + '</h3') : '');

	$('.location_name').html(ps_name);
	$('.location_header').html('<h1>' + ps_header + '</h1>');
	$('.location_info').html( ps_information );
	$('.location_info_two').html(ps_information_two);
	$('.location_address').html(ps_address);
	$('.location_website').html('<a href="http://'+ ps_location_website +'">' + ps_location_website +'</a>');
	if (data.location.image != null) {
	//  $('.location_image').html('<img src="https://s3.amazonaws.com/ps-wifi/location_images/' + data.location.id + '/medium/'+ data.location.image +'" alt="" class="thumbnail">');
	//}
	$('.location_logo').html(( data.location.remove_polkaspots == true ) ? '' : '<a href="http://' + ps_location_website + '"><img src="https://s3.amazonaws.com/ps-wifi/logos/' + data.location.id +'/medium/'+ data.location.logo +'" alt="" class=" customer-logo"></a>' );}
	$('.lazy').html(ps_lazy);
	$('head').append( '<link href="http://mustache.my-wifi.co/css/layout-'+ data.location.design +'.css" media="screen" rel="stylesheet" type="text/css" />' );
	$('head').append( '<link href="http://mustache.my-wifi.co/css/theme-'+ data.location.theme +'.css" media="screen" rel="stylesheet" type="text/css" />' );
	$('head').append( '<style>body{ font-family:' + data.location.font + '}'+ data.location.css +'</style>' );

	// General Stuff //

	$('<div id="footer"><div id="footer-left">' + data.wisp.copyright + '</div><div id="footer-right">' + data.wisp.terms + '</div></div>').insertAfter('#container');

	if ( params('notyet') != null ) {
		$.cookie('uamip', params('uamip'));	
		$.cookie('uamport', params('uamport'));	
	}

	if ( $success_url != null ) {
  	$.cookie('success_url', $success_url, { expires: 600 })
	}
	else {
		$.cookie('success_url', null)
	}
	
	jsonStatus();
	polkaSMS(loc);
	clearCookiesSMS();

},
  error: function() {
    //alert('Uh oh!');
  }
});
}

// SMS Auth //
function polkaSMS(loc) {
	var $form = $('#smsForm');
	$form.on('submit', function() {
	 $('#sms_login_form').hide();
	 $('#message').hide();
	 $('#loggingIn').show().html("<img src='http://mustache.my-wifi.co/images/ajax-loader.gif' alt=''><h2>Hold on, we're creating your password.</h2>");
  
	 $.ajax({
	 dataType: 'jsonp',
	 url: 'https://api.polkaspots.com/api/v1/locations/sms.json',
   data: $form.serialize() + '&request_uri=' + document.location.hostname + '&location_id=' + loc + '&mac=' + params('mac'),
	 success: function(data) {
		$('#loggingIn').hide();
	  var new_data = Mustache.to_html(data.form, 
	   {
	      challenge: params('challenge'),
	      uamip: params('uamip'),
	      uamport: params('uamport'),
	      called: params('called'),
	      mac: params('mac'),
	      sessionid: params('sessionid'),
	      ip: params('ip'),
	      username: data.username,
	      newsletter: data.newsletter,
	      success_url: data.location.success_url,
				unique_id: data.location.unique_id,
				remove_registration_link: data.location.remove_registration_link
	      }
	  );
		if ( data.response_code != 422) {
			//alert(data.response_code)
			$.cookie("sms", true)}
		else {
			//alert('true');
			//$.cookie("sms", true);}
		};
		
		$('#message').fadeIn();
		$('#sms_login_form').hide().html(new_data).fadeIn();
		$('#message').html('<div class="alert alert-danger"><strong><span class="text-error">' + data.message + '</h3></div></strong>');
		clearCookiesSMS();
		polkaSMS(loc);
	},
	error: function(responseText, statusText, xhr) {
	  console.log("Failure");
	}
	});
	return false;
	});
};

function clearCookiesSMS() {
	$("#reset_sms_form").click(function() {
		$.cookie("sms", false);
	  location.reload();
	});
};

function jsonStatus() {
 
 $.ajax({
  url: 'http://' + $.cookie("uamip") + ':' + $.cookie("uamport") +'/json/status?',
  type: 'application/x-javascript',
  dataType: 'jsonp',
  success: function(data) {
	 test = data
	 if ( test.clientState == 1 ) {

     var lazy_info_template = "<p>You logged in at: {{{startTime}}}</p><p>Session time: {{{sessionTime}}}</p><p>Downloaded: {{{ inputOctets }}}</p><p>{{{ ouputOctets }}}</p><a href='{{{ logoutURL }}}' class='btn btn-danger'>Logout</a>";
	   date = new Date(data.session.startTime*1000);
		 formatedDate = date.getHours() + ':' + date.getMinutes() + ' on ' + date.getDate() + '/' + date.getMonth() + '/' + date.getYear();
		 sessionTime = Math.floor(data.accounting.sessionTime / 60) + ' minutes'
		 inputOctets = Math.floor(data.accounting.inputOctets / (1024 * 1024)) + ' Mb'
	   var ps_lazy_info = Mustache.to_html(lazy_info_template, 
	     {
	       logoutURL: data.redir.logoutURL,
	       startTime: formatedDate,
	       sessionTime: sessionTime,
	       inputOctets: inputOctets,
	       ouputOctets: data.accounting.ouputOctets,
	     }
	   );	
		 $('#polkaform').hide();
	   $('#message').html('You are logged in, nice.').addClass('alert alert-info')
	   $('#lazy_info').html(ps_lazy_info)
   };	 
 },

  error: function(data) {
	 //alert('no');
}

});
};
