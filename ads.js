// One ad on content pages (guides, about, contact), created once and never re-rendered.
// Off until config.js has ADSENSE_CLIENT and ADSENSE_SLOT, and never inside the Google Play app.
(function () {
  var CFG = window.FIT_CONFIG || {}, play = false;
  try {
    if (document.referrer.indexOf("android-app://") === 0) sessionStorage.setItem("fit-play", "1");
    play = sessionStorage.getItem("fit-play") === "1";
  } catch (e) { /* ignore */ }
  var box = document.getElementById("adbox");
  if (!box || !CFG.ADSENSE_CLIENT || !CFG.ADSENSE_SLOT || play) return;
  box.innerHTML = '<div class="adlabel">Advertisement</div><ins class="adsbygoogle" style="display:block" data-ad-client="' + CFG.ADSENSE_CLIENT + '" data-ad-slot="' + CFG.ADSENSE_SLOT + '" data-ad-format="auto" data-full-width-responsive="true"></ins>';
  box.hidden = false;
  var js = document.createElement("script");
  js.async = true; js.crossOrigin = "anonymous";
  js.src = "https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=" + encodeURIComponent(CFG.ADSENSE_CLIENT);
  document.head.appendChild(js);
  try { (window.adsbygoogle = window.adsbygoogle || []).push({}); } catch (e) { /* ad blocker */ }
})();
