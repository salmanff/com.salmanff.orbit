
// com.salmanff.orbit preview.js

/*  global freezr, freepr, freezrMeta, Request, fetch, orbitOnLoad */

freezr.initPageScripts = function () {
  const params = new URLSearchParams(document.location.search.substring(1))
  const name = params.get('page')
  let pageDetails = null

  freepr.ceps.getquery({ collection: 'pages', q: { name } })
    .then(pageData => {
      pageDetails = getFromList(name, 'name', pageData)

      const pageRequest = new Request('/feps/fetchuserfiles/com.salmanff.orbit/' + freezrMeta.userId + '/' + name)
      return fetch(pageRequest, {
        headers: { Authorization: ('Bearer ' + freezr.utils.getCookie('app_token_' + freezrMeta.userId)) }
      })
    })
    .then(response => response.text())
    .then(response => {
      document.getElementsByTagName('BODY')[0].innerHTML = response

      pageDetails.js.forEach(jsFile => {
        addToPageAsScript(jsFile.name)
      })
      pageDetails.css.forEach(cssFile => {
        addToPageAsCSS(cssFile.name)
      })
    })
    .catch(e => {
      console.warn(e)
    })

  const getFromList = function (value, attr, list) {
    let hit = null
    list.forEach((item) => {
      if (item[attr] === value) hit = item
    })
    return hit
  }
  const addToPageAsScript = function (fileName) {
    const fullName = fileName
    freezr.utils.getFileToken(fullName, {}, function (fileToken) {
      const path = '/feps/userfiles/com.salmanff.orbit/' + freezrMeta.userId + '/' + fullName + '?fileToken=' + fileToken
      const script = document.createElement('script')
      script.src = path
      script.type = 'text/javascript'
      script.defer = true
      document.getElementsByTagName('head').item(0).appendChild(script)
      script.onload = () => {
        if (typeof orbitOnLoad !== 'undefined') {
          orbitOnLoad()
        }
      }
    })
  }
  const addToPageAsCSS = function (fileName) {
    const fullName = fileName
    freezr.utils.getFileToken(fullName, {}, function (fileToken) {
      const path = '/feps/userfiles/com.salmanff.orbit/' + freezrMeta.userId + '/' + fullName + '?fileToken=' + fileToken
      const link = document.createElement('link')
      link.href = path
      link.type = 'text/css'
      link.rel = 'stylesheet'
      document.getElementsByTagName('head').item(0).appendChild(link)
    })
  }
}
