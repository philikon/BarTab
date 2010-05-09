var EXPORTED_SYMBOLS = ["BarTabWebNavigation", "BarTabUtils"];
Components.utils.import("resource://gre/modules/XPCOMUtils.jsm");

const Cc = Components.classes;
const Ci = Components.interfaces;
const Cr = Components.results;


/*
 * Firefox 3.5 doesn't have these handy functions for defining lazy getters.
 */
if (typeof XPCOMUtils.defineLazyGetter !== "function") {
  XPCOMUtils.defineLazyGetter = function(aObject, aName, aLambda) {
    aObject.__defineGetter__(aName, function() {
      delete aObject[aName];
      return aObject[aName] = aLambda.apply(aObject);
    });
  };
}

if (typeof XPCOMUtils.defineLazyServiceGetter !== "function") {
  XPCOMUtils.defineLazyServiceGetter = function(aObject, aName,
                                                aContract, aInterfaceName) {
    XPCOMUtils.defineLazyGetter(aObject, aName, function XPCU_serviceLambda() {
      return Cc[aContract].getService(Ci[aInterfaceName]);
    });
  };
}


function BarTabWebNavigation () {}
BarTabWebNavigation.prototype = {

    /*
     * Install ourself as browser's webNavigation.  This needs to be
     * passed the tab object (rather than just its associated browser
     * object) because we need to be able to read and change tab's
     * 'ontap' attribute.
     */
    hook: function (aTab) {
        this._tab = aTab;
        this._original = aTab.linkedBrowser.webNavigation;

        var self = this;
        aTab.linkedBrowser.__defineGetter__('webNavigation', function () {
            return self;
        });
    },

    /*
     * Restore the browser's original webNavigation.
     */
    unhook: function () {
        if (this._tab.linkedBrowser.webNavigation === this) {
            // This will delete the instance getter for 'webNavigation',
            // thus revealing the original implementation.
            delete this._tab.linkedBrowser.webNavigation;
        }
        delete this._original;
        delete this._tab;
    },

    /*
     * This will be replaced with either _resumeGotoIndex or _resumeLoadURI,
     * unless it's a blank tab.  For the latter case we make sure we'll
     * unhook ourselves.
     */
    resume: function () {
        this.unhook();
    },


    /*** Hook into gotoIndex() ***/

    gotoIndex: function (aIndex) {
        if (this._tab.getAttribute("ontap") == "true") {
            return this._pauseGotoIndex(aIndex);
        }
        return this._original.gotoIndex(aIndex);
    },

    _pauseGotoIndex: function (aIndex) {
        var history = this._original.sessionHistory;
        var entry = history.getEntryAtIndex(aIndex, false);
        if (BarTabUtils.whiteListed(entry.URI)) {
            this._tab.removeAttribute("ontap");
            return this._original.gotoIndex(aIndex);
        }

        this._tab.removeAttribute("busy");
        this._tab.label = entry.title;
        let window = this._tab.ownerDocument.defaultView;
        window.setTimeout(BarTabUtils.setIcon, 0, this._tab, entry.URI);

        // Fake the docshell's currentURI.  (This will also affect
        // window.location etc.)
        this._tab.linkedBrowser.docShell.setCurrentURI(entry.URI);
        this._referringuri = entry.referrerURI;

        this._gotoindex = aIndex;
        this.resume = this._resumeGotoIndex;
    },

    _resumeGotoIndex: function () {
        var index = this._gotoindex;
        var original = this._original;
        delete this._gotoindex;
        delete this._referringuri;
        this.unhook();
        return original.gotoIndex(index);
    },


    /*** Hook into loadURI() ***/

    loadURI: function (aURI) {
        // We allow about:blank to load
        if (aURI
            && (aURI != "about:blank")
            && (this._tab.getAttribute("ontap") == "true")) {
            return this._pauseLoadURI.apply(this, arguments);
        }
        return this._original.loadURI.apply(this._original, arguments);
    },

    _pauseLoadURI: function (aURI, aLoadFlags, aReferrer) {
        var uri = BarTabUtils.makeURI(aURI);
        if (BarTabUtils.whiteListed(uri)) {
            let original = this._original;
            this._tab.removeAttribute("ontap");
            this.unhook();
            return original.loadURI.apply(original, arguments);
        }

        this._tab.removeAttribute("busy");
        let window = this._tab.ownerDocument.defaultView;
        window.setTimeout(BarTabUtils.setTitleAndIcon, 0, this._tab, uri);

        // Fake the docshell's currentURI.  (This will also affect
        // window.location etc.)
        this._tab.linkedBrowser.docShell.setCurrentURI(uri);
        if (aReferrer instanceof Ci.nsIURI) {
            this._referringuri = aReferrer.clone();
        }

        this._loaduri_args = arguments;
        this.resume = this._resumeLoadURI;
    },

    _resumeLoadURI: function () {
        var args = this._loaduri_args;
        var original = this._original;
        delete this._loaduri_args;
        delete this._referringuri;
        this.unhook();
        return original.loadURI.apply(original, args);
    },


    /*** Behaviour changed for unloaded tabs. ***/

    get referringURI() {
        if (this._referringuri) {
            return this._referringuri.clone();
        }
        return this._original.currentURI;
    },

    reload: function(aReloadFlags) {
        if (this._tab.getAttribute("ontap") == "true") {
            this._tab.removeAttribute("ontap");
            //TODO should we patch aReloadFlags into this._loaduri_args?
            return this.resume();
        }
        return this._original.reload(aReloadFlags);
    },

    QueryInterface: function(aIID) {
        if (Ci.nsISupports.equals(aIID) || Ci.nsIWebNavigation.equals(aIID)) {
            return this;
        }
        return this._original.QueryInterface(aIID);
    },


    /*** These methods and properties are simply passed through. ***/

    goBack: function () {
        return this._original.goBack();
    },
    goForward: function () {
        return this._original.goForward();
    },
    stop: function(aStopFlags) {
        return this._original.stop(aStopFlags);
    },
    get currentURI() {
        return this._original.currentURI;
    },
    get canGoBack() {
        return this._original.canGoBack;
    },
    get canGoForward() {
        return this._original.canGoForward;
    },
    get document() {
        return this._original.document;
    },
    get sessionHistory() {
        return this._original.sessionHistory;
    }
};


var BarTabUtils = {

    /*
     * Create a new URI object.
     */
    makeURI: function(aURL, aOriginCharset, aBaseURI) {
        return this.mIO.newURI(aURL, aOriginCharset, aBaseURI);
    },

    /*
     * Find and set the tab's favicon for a given URI.
     */
    setIcon: function(aTab, aURI) {
        try {
            let iconURI = BarTabUtils.mFavicon.getFaviconForPage(aURI);
            aTab.setAttribute("image", iconURI.spec);
        } catch (ex) {
            // No favicon found.  Perhaps it's a URL with an anchor?
            // Firefox doesn't always store favicons for those.
            // See https://bugzilla.mozilla.org/show_bug.cgi?id=420605
            aURI = BarTabUtils.stripFragmentFromURI(aURI);
            if (aURI) {
                BarTabUtils.setIcon(aTab, aURI);
            }
        }
    },

    /*
     * Set a tab's title and favicon given a URI by querying the history
     * service.
     */
    setTitleAndIcon: function(aTab, aURI) {
        // See if we have title, favicon in stock for it. This should
        // definitely work for restored tabs as they're in the history
        // database.
        let info = BarTabUtils.getInfoFromHistory(aURI);
        if (!info) {
            aTab.label = BarTabUtils.titleFromURI(aURI);
            return;
        }
        // Firefox cripples nsINavHistoryService entries for fragment links.
        // See https://bugzilla.mozilla.org/show_bug.cgi?id=503832
        // Try to work around that by stripping the fragment from the URI.
        if (!info.icon) {
            let uri = BarTabUtils.stripFragmentFromURI(aURI);
            if (uri) {
                let anchorinfo = BarTabUtils.getInfoFromHistory(uri);
                if (anchorinfo) {
                    info = anchorinfo;
                }
            }
        }
        aTab.setAttribute("image", info.icon);
        aTab.label = info.title;
    },

    /*
     * Strip the fragment from a URI.  Returns a new URI object, or null
     * if the URI didn't contain a fragment.
     */
    stripFragmentFromURI: function(aURI) {
        var anchor = aURI.path.indexOf('#');
        if (anchor == -1) {
            return null;
        }
        let uri = aURI.clone();
        uri.path = uri.path.substr(0, anchor);
        return uri;
    },

    /*
     * Derive a title from a URI by stripping the protocol and potentially
     * "www.", so "http://www.mozilla.org" would become "mozilla.org".
     */
    titleFromURI: function(aURI) {
        try {
            let hostPort = aURI.hostPort;
            let path = aURI.path;
            if (hostPort.substr(0, 4) == "www.") {
                hostPort = hostPort.substr(4);
            }
            if (path == "/") {
                path = "";
            }
            return hostPort + path;
        } catch (ex) {
            // Most likely aURI.hostPort and aURI.path failed.
            // Let's handle this gracefully.
            return aURI.spec;
        }
    },

    /*
     * Get information about a URI from the history service,
     * e.g. title, favicon, ...
     */
    getInfoFromHistory: function(aURI) {
        var history = BarTabUtils.mHistory;
        var options = history.getNewQueryOptions();
        options.queryType = Ci.nsINavHistoryQueryOptions.QUERY_TYPE_HISTORY;
        options.maxResults = 1;

        var query = history.getNewQuery();
        query.uri = aURI;

        var result = history.executeQuery(query, options);
        result.root.containerOpen = true;

        if (!result.root.childCount) {
            return null;
        }
        return result.root.getChild(0);
    },

    /*
     * Check whether a URI is on the white list.
     */
    whiteListed: function(aURI) {
        try {
            return (BarTabUtils.getHostWhitelist().indexOf(aURI.host) != -1);
        } catch(ex) {
            // Most likely gotouri.host failed, so it isn't on the white list.
            return false;
        }
    },

    /*
     * It might seem more elegant to use a getter & setter here so you
     * could just use this.hostWhiteList or similar.  However, that
     * would suggest this.hostWhiteList would always return the same
     * array and that mutations to it would be persisted.  Both are
     * not the case.
     */

    getHostWhitelist: function() {
        var whitelist = BarTabUtils.mPrefs.getCharPref(
            "extensions.bartap.hostWhitelist");
        if (!whitelist) {
            return [];
        }
        return whitelist.split(";");
    },

    setHostWhitelist: function(whitelist) {
        BarTabUtils.mPrefs.setCharPref("extensions.bartap.hostWhitelist",
                                       whitelist.join(";"));
    }

};

/*
 * Lazy getters for XPCOM services.  This is in analogy to
 * Services.jsm which is available in Firefox 3.7.
 */
XPCOMUtils.defineLazyGetter(BarTabUtils, "mPrefs", function () {
  return Cc["@mozilla.org/preferences-service;1"]
         .getService(Ci.nsIPrefService)
         .QueryInterface(Ci.nsIPrefBranch2);
});
XPCOMUtils.defineLazyServiceGetter(BarTabUtils, "mIO",
                                   "@mozilla.org/network/io-service;1",
                                   "nsIIOService");
XPCOMUtils.defineLazyServiceGetter(BarTabUtils, "mSessionStore",
                                   "@mozilla.org/browser/sessionstore;1",
                                   "nsISessionStore");
XPCOMUtils.defineLazyServiceGetter(BarTabUtils, "mHistory",
                                   "@mozilla.org/browser/nav-history-service;1",
                                   "nsINavHistoryService");
XPCOMUtils.defineLazyServiceGetter(BarTabUtils, "mFavicon",
                                   "@mozilla.org/browser/favicon-service;1",
                                   "nsIFaviconService");
