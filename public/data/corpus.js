/* This file has been superseded by server-side search.
   Force a hard reload so the browser fetches the current page. */
(function(){
  if (typeof location !== 'undefined') {
    location.replace(location.pathname + '?bust=' + Date.now());
  }
})();
