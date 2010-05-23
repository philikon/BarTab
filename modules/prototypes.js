var EXPORTED_SYMBOLS = ["BarTabHandler",
                        "BarTabUtils"];
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


/*
 * This handler attaches to the tabbrowser.  It listens to various tab
 * related events to prevent tabs from loading or to load them upon
 * the user's request (e.g. automatic timer or context menu item).
 *
 * This object provides a small public API (see below) to perform
 * these tasks programatically, too.  You may obtain a reference to it
 * via tabbrowser.BarTabHandler.
 */
function BarTabHandler() {}
BarTabHandler.prototype = {

    init: function(aTabBrowser) {
        aTabBrowser.BarTabHandler = this;
        this.tabbrowser = aTabBrowser;

        let document = aTabBrowser.ownerDocument;
        this.l10n = document.getElementById('bartab-strings');

        aTabBrowser.tabContainer.addEventListener('SSTabRestoring', this, false);
        aTabBrowser.tabContainer.addEventListener('TabOpen', this, false);
        aTabBrowser.tabContainer.addEventListener('TabSelect', this, false);
        aTabBrowser.tabContainer.addEventListener('TabClose', this, false);

        (new BarTabTimer()).init(aTabBrowser);

        // We need an event listener for the context menu so that we can
        // adjust the label of the whitelist menu item
        let popup = aTabBrowser.tabContainer.contextMenu;
        if (!popup) {
            // In Firefox <3.7, the tab context menu lives inside the
            // tabbrowser.
            popup = document.getAnonymousElementByAttribute(
                aTabBrowser, "anonid", "tabContextMenu");
            let before = document.getAnonymousElementByAttribute(
                aTabBrowser, "id", "context_openTabInWindow");
            ["context_BarTabUnloadTab",
             "context_BarTabUnloadOtherTabs",
             "context_BarTabNeverUnload",
             "context_BarTabSeparator"].forEach(function (menuitemid) {
                let menuitem = document.getElementById(menuitemid);
                popup.insertBefore(menuitem, before);
            });
        }
        popup.addEventListener('popupshowing', this, false);
    },


    /*** Event handlers ***/

    handleEvent: function(aEvent) {
        switch (aEvent.type) {
        case 'SSTabRestoring':
            this.onTabRestoring(aEvent);
            return;
        case 'TabOpen':
            this.onTabOpen(aEvent);
            return;
        case 'TabSelect':
            this.onTabSelect(aEvent);
            return;
        case 'TabClose':
            this.onTabClose(aEvent);
            return;
        case 'popupshowing':
            this.onPopupShowing(aEvent);
            return;
        }
    },

    /*
     * Hook into newly opened tabs if the user wants to prevent tabs
     * opened in the background from loading.  (If this tab ends up not
     * being in the background after all, 'onTabSelect' will take care
     * of loading the tab.)
     */
    onTabOpen: function(aEvent) {
        var tab = aEvent.originalTarget;
        if (tab.selected || !BarTabUtils.getBoolPref("tapBackgroundTabs")) {
            return;
        }
        tab.setAttribute("ontap", "true");
        (new BarTabWebProgressListener()).hook(tab);
        (new BarTabWebNavigation()).hook(tab);
    },

    /*
     * Listen to the 'SSTabRestoring' event from the nsISessionStore
     * service and hook into restored tabs if the user wants to prevent
     * restored tabs from loading.
     */
    onTabRestoring: function(aEvent) {
        if (!BarTabUtils.getBoolPref("tapRestoredTabs")) {
            return;
        }
        let tab = aEvent.originalTarget;
        if (tab.selected || tab.getAttribute("ontap") == "true") {
            return;
        }
        tab.setAttribute("ontap", "true");
        (new BarTabWebNavigation()).hook(tab);
    },

    onTabSelect: function(aEvent) {
        var tab = aEvent.originalTarget;
        if (tab.getAttribute("ontap") != "true") {
            return;
        }

        // Always load a blank page immediately
        let uri = tab.linkedBrowser.webNavigation.currentURI;
        if (!uri || (uri.spec == "about:blank")) {
            this.loadTab(tab);
            return;
        }

        let self = this;

        switch (BarTabUtils.getIntPref("loadOnSelect")) {
        case 1:
            // Load immediately
            this.loadTab(tab);
            return;
        case 2:
            // Load after delay
            let delay = BarTabUtils.getIntPref("loadOnSelectDelay");
            let window = tab.ownerDocument.defaultView;
            window.setTimeout(function() {
                if (tab.selected) {
                    self.loadTab(tab);
                }
            }, delay);
            return;
        case 0:
            // Ask whether to load
            let box = this.tabbrowser.getNotificationBox(tab.linkedBrowser);
            let label = this.l10n.getString("loadNotification");
            let buttons = [{
                label: this.l10n.getString("loadButton"),
                accessKey: this.l10n.getString("loadButton.accesskey"),
                callback: function() {self.loadTab(tab);}}];
            box.appendNotification(label, 'bartab-load', "",
                                   box.PRIORITY_INFO_MEDIUM, buttons);
            return;
        }
    },

    onTabClose: function(aEvent) {
        if (!BarTabUtils.getBoolPref("findClosestUntappedTab")) {
            return;
        }
        let tab = aEvent.originalTarget;
        if (!tab.selected) {
            return;
        }
        let activeTab = this.findClosestLoadedTab(tab);
        if (activeTab) {
            this.tabbrowser.selectedTab = activeTab;
        }
    },

    onPopupShowing: function(aEvent) {
        var document = aEvent.target.ownerDocument;
        var tab =  document.popupNode.localName == "tab" ?
            document.popupNode : gBrowser.selectedTab;

        var neverunload = document.getElementById("context_BarTabNeverUnload");
        var unloadtab = document.getElementById("context_BarTabUnloadTab");

        let host;
        try {
            host = tab.linkedBrowser.currentURI.host;
        } catch (ex) {
            // Most likely uri.host doesn't exist which probably means
            // whitelisting doesn't make sense on this tab.  Set empty
            // host so we don't show the menu item
            host = '';
        }
        if (!host) {
            neverunload.setAttribute("hidden", "true");
            unloadtab.removeAttribute("disabled");
            return;
        }

        let label = this.l10n.getFormattedString('neverUnload', [host]);
        neverunload.setAttribute("label", label);
        neverunload.removeAttribute("hidden");
        if (BarTabUtils.whiteListed(tab.linkedBrowser.currentURI)) {
            neverunload.setAttribute("checked", "true");
            unloadtab.setAttribute("disabled", "true");
            return;
        }

        neverunload.removeAttribute("checked");
        if (tab.getAttribute("ontap") == "true") {
            unloadtab.setAttribute("disabled", "true");
        } else {
            unloadtab.removeAttribute("disabled");
        }
    },


    /*** Public API ***/

    loadTab: function(aTab) {
        if (aTab.getAttribute("ontap") != "true") {
            return;
        }
        aTab.removeAttribute("ontap");
        aTab.linkedBrowser.webNavigation._resume();
    },

    unloadTab: function(aTab) {
        // Ignore tabs that are already unloaded or are on the host whitelist.
        if (aTab.getAttribute("ontap") == "true") {
            return;
        }
        if (BarTabUtils.whiteListed(aTab.linkedBrowser.currentURI)) {
            return;
        }

        let tabbrowser = this.tabbrowser;

        // Make sure that we're not on this tab.  If we are, find the
        // closest tab that isn't on the bar tab.
        if (aTab.selected) {
            let activeTab = this.findClosestLoadedTab(aTab);
            if (activeTab) {
                tabbrowser.selectedTab = activeTab;
            }
        }

        var sessionstore = BarTabUtils.mSessionStore;
        var state = sessionstore.getTabState(aTab);
        var newtab = tabbrowser.addTab();

        // The user might not have the 'extensions.bartap.tapRestoredTabs'
        // preference enabled but still wants to unload this tab.  That's
        // why we need to make sure we hook into the new tab before
        // restoring the tab state.
        if (newtab.getAttribute("ontap") != "true") {
            newtab.setAttribute("ontap", "true");
            (new BarTabWebNavigation()).hook(newtab);
        }
        sessionstore.setTabState(newtab, state);

        // Move the new tab next to the one we're removing, but not in
        // front of it as that confuses Tree Style Tab.
        tabbrowser.moveTabTo(newtab, aTab._tPos + 1);

        // Restore tree when using Tree Style Tab
        if (tabbrowser.treeStyleTab) {
            let children = tabbrowser.treeStyleTab.getChildTabs(aTab);
            children.forEach(function(aChild) {
                tabbrowser.treeStyleTab.attachTabTo(
                    aChild, newtab, {dontAnimate: true});
            });
        }

        // Close the original tab.  We're taking the long way round to
        // ensure the nsISessionStore service won't save this in the
        // recently closed tabs.
        tabbrowser._endRemoveTab(tabbrowser._beginRemoveTab(aTab, true, null, false));
    },

    unloadOtherTabs: function(aTab) {
        var tabbrowser = this.tabbrowser;

        // Make sure we're sitting on the tab that isn't going to be unloaded.
        if (tabbrowser.selectedTab != aTab) {
            tabbrowser.selectedTab = aTab;
        }

        // unloadTab() mutates the tabs so the only sane thing to do is to
        // copy the list of tabs now and then work off that list.
        var tabs = [];
        for (let i = 0; i < tabbrowser.mTabs.length; i++) {
            tabs.push(tabbrowser.mTabs[i]);
        }
        var self = this;
        tabs.forEach(function(tab) {
            if (tab != aTab) {
                self.unloadTab(tab);
            }
        });
    },

    toggleHostWhitelist: function(aTab) {
        var uri = aTab.linkedBrowser.currentURI;
        try {
            var host = uri.host;
        } catch(ex) {
            // Most likely uri.host doesn't exist.  Ignore then.
            return;
        }

        let whitelist = BarTabUtils.getHostWhitelist();
        let index = whitelist.indexOf(host);
        if (index == -1) {
            whitelist.push(host);
        } else {
            whitelist.splice(index, 1);
        }

        BarTabUtils.setHostWhitelist(whitelist);
    },

    /*
     * In relation to a given tab, find the closest tab that is loaded.
     * Note: if there's no such tab available, this will return unloaded
     * tabs as a last resort.
     */
    findClosestLoadedTab: function(aTab) {
        var tabbrowser = this.tabbrowser;

        // Shortcut: if this is the only tab available, we're not going to
        // find another active one, are we...
        if (tabbrowser.mTabs.length == 1) {
            return null;
        }

        // The most obvious choice would be the owner tab, if it's active.
        if (aTab.owner
            && BarTabUtils.mPrefs.getBoolPref("browser.tabs.selectOwnerOnClose")
            && aTab.owner.getAttribute("ontap") != "true") {
            return aTab.owner;
        }

        // Otherwise walk the tab list and see if we can find an active one.
        let i = 1;
        while ((aTab._tPos - i >= 0) ||
               (aTab._tPos + i < tabbrowser.mTabs.length)) {
            if (aTab._tPos + i < tabbrowser.mTabs.length) {
                if (tabbrowser.mTabs[aTab._tPos+i].getAttribute("ontap") != "true") {
                    return tabbrowser.mTabs[aTab._tPos+i];
                }
            }
            if (aTab._tPos - i >= 0) {
                if (tabbrowser.mTabs[aTab._tPos-i].getAttribute("ontap") != "true") {
                    return tabbrowser.mTabs[aTab._tPos-i];
                }
            }
            i++;
        }

        // Fallback: there isn't an active tab available, so we're going
        // to have to nominate a non-active one.
        if (aTab.owner
            && BarTabUtils.mPrefs.getBoolPref("browser.tabs.selectOwnerOnClose")) {
            return aTab.owner;
        }
        if (aTab.nextSibling) {
            return aTab.nextSibling;
        }
        return aTab.previousSibling;
    }
};


/*
 * A wrapping implementation of nsIWebNavigation.
 *
 * It can install itself as the webNavigation property of a tab's
 * browser object, replacing and wrapping around the original
 * implementation.  Once it has done so, it will defer all URI loading
 * until the tab is no longer marked as 'ontap'.
 *
 * This provides a new method on top of nsIWebNavigation called
 * 'resume()' which allows you to resume the operation that was
 * deferred.
 */
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
        if (this._tab._barTabProgressListener) {
            this._tab._barTabProgressListener.unhook();
        }

        delete this._gotoindex;
        delete this._loaduri_args;
        delete this._referringuri;

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
    _resume: function () {
        this.unhook();
    },

    _unfakeDocshellURI: function () {
        // No longer lie about the URI.  Otherwise the docshell might
        // not want to load the page (especially seems to happen with
        // fragment URIs).
        var blankURI = BarTabUtils.makeURI("about:blank");
        this._tab.linkedBrowser.docShell.setCurrentURI(blankURI);
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
        this._resume = this._resumeGotoIndex;
    },

    _resumeGotoIndex: function () {
        var index = this._gotoindex;
        var original = this._original;
        this._unfakeDocshellURI();
        this.unhook();
        return original.gotoIndex(index);
    },


    /*** Hook into loadURI() ***/

    loadURI: function (aURI) {
        // Allow about:blank to load without any side effects.
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
        if (aReferrer) {
            // Fake the docshell's currentURI.  (This will also affect
            // window.location etc.)
            this._tab.linkedBrowser.docShell.setCurrentURI(uri);
            window.setTimeout(BarTabUtils.setTitleAndIcon, 0, this._tab, uri);
        } else {
            // If there's no referrer, it's likely that we were opened
            // from an external application which somehow sets up things
            // like tab title and currentURI later.  Avoid the race
            // with an increased timeout.
            window.setTimeout(this._tab.linkedBrowser.docShell.setCurrentURI,
                              100, uri);
            window.setTimeout(BarTabUtils.setTitleAndIcon, 100, this._tab, uri);
        }

        if (aReferrer instanceof Ci.nsIURI) {
            this._referringuri = aReferrer.clone();
        }

        this._loaduri_args = arguments;
        this._resume = this._resumeLoadURI;
    },

    _resumeLoadURI: function () {
        var args = this._loaduri_args;
        var original = this._original;
        this._unfakeDocshellURI();
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
            return this._resume();
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


/*
 * Progress listener that stops the loading of tabs that are opened in
 * the background and whose contents is loaded by C++ code.  This
 * occurs for instance when the 'browser.tabs.loadDivertedInBackground'
 * preference is enabled (because links are always opened by docshell code).
 */
function BarTabWebProgressListener () {}
BarTabWebProgressListener.prototype = {

    hook: function (aTab) {
        this._tab = aTab;
        aTab._barTabProgressListener = this;
        aTab.linkedBrowser.webProgress.addProgressListener(
            this, Ci.nsIWebProgress.NOTIFY_ALL);
    },

    unhook: function () {
        this._tab.linkedBrowser.webProgress.removeProgressListener(this);
        delete this._tab._barTabProgressListener;
        delete this._tab;
    },

    /*** nsIWebProgressListener ***/

    onStateChange: function (aWebProgress, aRequest, aStateFlags, aStatus) {
        if (!aRequest) {
            return;
        }
        if (!(aStateFlags & Ci.nsIWebProgressListener.STATE_START)
            || !(aStateFlags & Ci.nsIWebProgressListener.STATE_IS_NETWORK)
            || (aStateFlags & Ci.nsIWebProgressListener.STATE_RESTORING)) {
            return;
        }
        if (this._tab.getAttribute("ontap") != "true") {
            return;
        }

        // Allow about:blank and wyciwyg URIs to load without any side effects.
        let uri = aRequest.QueryInterface(Ci.nsIChannel).URI;
        if ((uri.spec == "about:blank") || (uri.scheme == "wyciwyg")) {
            return;
        }

        // Allow whitelisted URIs to load.
        let browser = this._tab.linkedBrowser;
        if (BarTabUtils.whiteListed(uri)) {
            this._tab.removeAttribute("ontap");
            // webNavigation.unhook() will call our unhook.
            browser.webNavigation.unhook();
            return;
        }

        // If it's an HTTP request, we want to set the right referrer.
        // And if it's a POST request on top of that, we want to make
        // sure we reuse the post data.
        let httpChannel;
        try {
            httpChannel = aRequest.QueryInterface(Ci.nsIHttpChannel);
        } catch (ex) {
            // Ignore.
        }

        let referrer;
        let postData;
        if (httpChannel) {
            referrer = httpChannel.referrer;
            let uploadChannel = httpChannel.QueryInterface(Ci.nsIUploadChannel);
            // uploadStream will be null or an nsIInputStream.
            postData = uploadChannel.uploadStream;
        }

        // Defer the loading.  Do this async so that other
        // nsIWebProgressListeners have a chance to update the UI
        // before _pauseLoadURI overwrites it all again.
        browser.stop();

        let flags = Ci.nsIWebNavigation.LOAD_FLAGS_NONE;
        let window = this._tab.ownerDocument.defaultView;
        window.setTimeout(function () {
            browser.webNavigation._pauseLoadURI(
                uri.spec, flags, referrer, postData, null);
        }, 0);
    },

    onProgressChange: function () {},
    onLocationChange: function () {},
    onStatusChange:   function () {},
    onSecurityChange: function () {},

    QueryInterface: XPCOMUtils.generateQI([Ci.nsIWebProgressListener,
                                           Ci.nsISupportsWeakReference,
                                           Ci.nsISupports])
};


/*
 * A timer that keeps track of how long ago each tab was last visited.
 * If that time reaches a user-defined value, it unloads the tab in
 * question.  (The actual implementation works differently.  It uses
 * setTimeout, of course).
 */
function BarTabTimer() {}
BarTabTimer.prototype = {

    init: function(aTabBrowser) {
        this.tabbrowser = aTabBrowser;
        aTabBrowser.tabContainer.addEventListener('TabOpen', this, false);
        aTabBrowser.tabContainer.addEventListener('TabSelect', this, false);
        aTabBrowser.tabContainer.addEventListener('TabClose', this, false);

        this.previousTab = null;
        this.selectedTab = aTabBrowser.selectedTab;
    },

    handleEvent: function(event) {
        switch (event.type) {
        case 'TabOpen':
            this.onTabOpen(event);
            return;
        case 'TabSelect':
            this.onTabSelect(event);
            return;
        case 'TabClose':
            this.onTabClose(event);
            return;
        }
    },

    onTabOpen: function(aEvent) {
        var tab = aEvent.originalTarget;
        if (tab.selected
            || BarTabUtils.getBoolPref("tapBackgroundTabs")) {
            return;
        }
        this.startTimer(tab);
    },

    onTabClose: function(event) {
        this.clearTimer(event.originalTarget);
        if (event.originalTarget == this.selectedTab) {
            this.selectedTab = null;
        };
        if (event.originalTarget == this.previousTab) {
            this.previousTab = null;
        };
    },

    onTabSelect: function(event) {
        this.previousTab = this.selectedTab;
        this.selectedTab = event.originalTarget;

        if (this.previousTab) {
            // The previous tab may not be available because it has
            // been closed.
            this.startTimer(this.previousTab);
        }
        this.clearTimer(this.selectedTab);
    },

    startTimer: function(aTab) {
        if (!BarTabUtils.getBoolPref("tapAfterTimeout")) {
            return;
        }
        if (aTab.getAttribute("ontap") == "true") {
            return;
        }

        if (aTab._barTabTimer) {
            this.clearTimer(aTab);
        }
        let secs = BarTabUtils.getIntPref("timeoutValue")
                 * BarTabUtils.getIntPref("timeoutUnit");
        let window = aTab.ownerDocument.defaultView;
        // Allow 'this' to leak into the inline function
        let self = this;
        aTab._barTabTimer = window.setTimeout(function() {
            // The timer will be removed automatically since
            // unloadTab() will close and replace the original tab.
            self.tabbrowser.BarTabHandler.unloadTab(aTab, self.tabbrowser);
        }, secs*1000);
    },

    clearTimer: function(aTab) {
        var window = aTab.ownerDocument.defaultView;
        window.clearTimeout(aTab._barTabTimer);
        aTab._barTabTimer = null;
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
        if (info.title) {
            aTab.label = info.title;
        } else {
            aTab.label = BarTabUtils.titleFromURI(aURI);
        }
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

    getBoolPref: function(aPref) {
         return BarTabUtils.mPrefs.getBoolPref("extensions.bartap." + aPref);
    },

    getIntPref: function(aPref) {
         return BarTabUtils.mPrefs.getIntPref("extensions.bartap." + aPref);
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
