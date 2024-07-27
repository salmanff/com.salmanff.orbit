
// index.js for com.salmanff.orbit

/* global freezr, freepr, freezrMeta, dg, Request, fetch, Blob, File */

var pages = []
var allMedia = []
const ACCEPTED_FILE_TYPES = ['html', 'js', 'css', 'htm', 'json', 'jpg', 'png', 'jpeg']
// Use html to define a page with js & css, use htm to define html elements to be used as readbale media

freezr.initPageScripts = function () {
  getAndDrawPages()
  // console.log( todo run a script to get all files and check if any are orphans and offer to delete and also check any error)
}

// Drawing Elements
const getAndDrawPages = async function () {
  pages = await freepr.feps.postquery({ collection: 'pages', count: 50 })
  if (pages && pages.length > 49) console.warn('App not able to deal with 50 pages')
  pages.forEach(page => {
    page.type = 'main'
  })
  pages = pages.reverse()

  allMedia = await freepr.feps.postquery({ collection: 'files', count: 100, q: { type: 'media' } })
  reDrawPages()
  // TODO GET ALL PAGES and Display
}
const reDrawPages = function () {
  dg.el('newPage').appendChild(dg.div({ style: { 'padding-left': '30px' } }, drawUploader('new', 'newPageUploader')))
  const pagesDiv = dg.el('allPages', { clear: true })
  if (pages.length === 0) {
    pagesDiv.innerText = 'You have no pages. Upload a new page by dropping files in dotted box above.'
  } else {
    pages.forEach(page => {
      createAndAppendPageDiv(page.name)
      drawPageDetails(page.name)
    })
  }
  const allMediaDiv = dg.el('allMedia', { clear: true })
  if (allMedia.length === 0) {
    allMediaDiv.innerText = 'You have no media uploaded. Upload new files or pictures by dropping files in dotted box above.'
  } else {
    allMedia.forEach(fileObj => {
      allMediaDiv.appendChild(drawMediaDetails(fileObj))
    })
  }
}
const createAndAppendPageDiv = function (name, makeGreen) {
  const pagesDiv = dg.el('allPages')
  const pageDiv = dg.div({ id: 'page_' + name, className: 'pageOuter' })
  if (makeGreen) pageDiv.style.border = '2px solid darkgreen'
  pagesDiv.insertBefore(pageDiv, pagesDiv.firstChild)
  return pageDiv
}
const drawPageDetails = function (pageName) {
  const pageDetails = getFromList(pageName, 'name', pages)
  const shortName = remove1stPathEl(removeExtension(pageDetails.name))
  const pageDiv = dg.el('page_' + pageName)
  if (!pageDetails || !pageDiv) {
    showError('Internal error drawing page', pageName)
    return null
  }
  pageDiv.appendChild(dg.a({ href: 'preview?page=' + pageDetails.name, className: 'preview' }, 'Preview Draft'))
  if (pageDetails.published) pageDiv.appendChild(dg.a({ href: '/' + pageDetails.publicid, className: 'preview' }, 'Preview Public'))
  pageDiv.appendChild(dg.div({ className: 'pageTitle' }, shortName))
  const jsDiv = dg.div({
    id: ('js_' + pageName),
    style: { 'padding-top': '5px' }
  }) // , 'Javascript files'
  pageDetails.js.forEach((item) => {
    jsDiv.appendChild(drawJsCssFileDiv(pageDetails, item))
  })
  pageDiv.appendChild(jsDiv)
  const cssDiv = dg.div({
    id: ('css_' + pageName),
    style: { 'padding-top': '5px' }
  })
  pageDetails.css.forEach((item) => {
    cssDiv.appendChild(drawJsCssFileDiv(pageDetails, item))
  })
  pageDiv.appendChild(cssDiv)
  pageDiv.appendChild(dg.div(drawUploader(pageName, 'page')))
  const buttHolder = dg.div({ style: { 'text-align': 'right' } })
  const removePageButt = dg.div({
    id: 'removePage_' + pageName,
    className: 'pageButt activeRed',
    onclick: function () {
      removePage(pageName)
    }
  }, 'Remove Page')
  if (pageDetails.published || pageDetails.js.length > 0 || pageDetails.css.length > 0) {
    removePageButt.style.display = 'none'
  }
  buttHolder.appendChild(removePageButt)

  const unPublishButt = dg.div({
    id: 'unpublish_' + pageName,
    className: 'pageButt activeRed',
    onclick: function (e) {
      unpublish(pageName)
    }
  }, 'Unpublish Page')
  if (!pageDetails.published) unPublishButt.style.display = 'none'
  buttHolder.appendChild(unPublishButt)

  const publishButt = dg.div({
    id: 'publish_' + pageName,
    className: 'pageButt activeBlue',
    onclick: function () { publishPage(pageName) }
  }, 'Publish Page')
  if (pageDetails.published && !pageDetails.postPublishFiles) publishButt.style.display = 'none'
  buttHolder.appendChild(publishButt)

  pageDiv.appendChild(buttHolder)
  pageDiv.appendChild(dg.div({
    id: 'status_' + pageName
  }))
}
const drawMediaDetails = function (fileObj, returnInner) {
  const fileName = fileObj._id // depending on whether it has been uploaded or not
  const theDiv = dg.div({
    id: ('media_' + fileName),
    className: 'fileDiv'
  })
  const inner = dg.div(remove1stPathEl(fileName))

  if (['png', 'jpg', 'jpeg'].includes(extFromFileName(fileName))) {
    var imgBox = dg.img({ className: 'leftPict' })
    inner.appendChild(imgBox)
    freezr.utils.setFilePath(imgBox, 'src', fileName, {})
  }
  inner.appendChild(dg.div({
    className: ('status ' + (fileObj.published ? 'activeRed' : 'activeBlue')),
    onclick: function () { togglePublishFile(inner, fileObj) }
  }, (fileObj.published ? 'Unpublish' : 'Publish')))
  if (!fileObj.published) {
    inner.appendChild(dg.div({
      className: 'status activeRed',
      onclick: function () { removeFile(inner, fileObj) }
    }, 'Remove'))
  }
  let updateText = 'Updated ' + new Date(fileObj._date_modified).toLocaleDateString() + ' ' + new Date(fileObj._date_modified).toLocaleTimeString()
  if (fileObj.published) updateText += '  Published ' + new Date(fileObj.published).toLocaleDateString() + ' ' + new Date(fileObj.published).toLocaleTimeString()
  inner.appendChild(dg.div({ className: 'small' }, updateText))
  if (fileObj.published) {
    inner.appendChild(dg.div({
      className: 'small',
      style: { 'margin-left': '50px' }
    }, '/' + fileObj.publicid))
  }
  if (returnInner) return inner
  theDiv.appendChild(inner)
  return theDiv
}
const fullDraftNameFromFile = function (file) {
  return 'drafts/' + file.name
}
const drawJsCssFileDiv = function (pageDetails, fileObj, returnInner) {
  const fullFileName = fileObj.name
  const pageName = pageDetails.name
  const theDiv = dg.div({
    id: ('file_' + pageName + '_' + fullFileName),
    className: 'fileDiv'
  })
  const inner = dg.div(remove1stPathEl(fullFileName))

  inner.appendChild(dg.div({
    className: 'status activeRed',
    onclick: function () { removeJsCssFile(inner, fileObj, pageDetails) }
  }, 'Remove'))
  let updateText = 'Updated ' + new Date(fileObj.update).toLocaleDateString() + ' ' + new Date(fileObj.update).toLocaleTimeString()
  if (fileObj.published) updateText += '  Published ' + new Date(fileObj.published).toLocaleDateString() + ' ' + new Date(fileObj.published).toLocaleTimeString()
  inner.appendChild(dg.div({ className: 'small' }, updateText))
  if (returnInner) return inner
  theDiv.appendChild(inner)
  return theDiv
}
const fileDivFrom = function (pageDetails, fullFileName) {
  const preface = (pageDetails.type === 'media') ? 'media' : (pageDetails.name === fullFileName ? 'page' : ('file_' + pageDetails.name))
  const theDiv = dg.el(preface + '_' + fullFileName)
  return theDiv
}
const drawUploader = function (pageName, type) {
  const preface = (type === 'page' ? 'existingPageUploader' : 'newPageUploader')
  const text = 'Drag & drop files here ' + (type === 'page' ? ('for the page ' + remove1stPathEl(pageName)) : 'to add new pages and media')
  return dg.div({
    id: preface + '_' + pageName,
    className: 'drop-area',
    ondragenter: handleDragEnter,
    ondragover: handleDragOver,
    ondragleave: handleDragLeave,
    ondrop: handleDrop
  }, text)
}
const reDrawUpdatedFileItem = function (fileDetails, pageDetails, borderColor = 'green') {
  const fileName = fileDetails ? fileDetails.name : null
  const fileDiv = fileDivFrom(pageDetails, fileName)
  if (!fileDiv || !fileName) {
    console.warn('could not find dov for ', { fileDetails, pageDetails })
    throw new Error('wtk')
  } else {
    fileDiv.innerHTML = ''
    fileDiv.appendChild(drawJsCssFileDiv(pageDetails, fileDetails, true))
    fileDiv.style.border = '2px dashed ' + borderColor
  }
}

// Hanlding dropped files
//  credit to https://www.smashingmagazine.com/2018/01/drag-drop-file-uploader-vanilla-js/ and https://developer.mozilla.org/en-US/docs/Web/API/HTML_Drag_and_Drop_API/File_drag_and_drop
const handleDragEnter = function (e) {
  preventDefaults(e)
  highlight(e)
}
const handleDragOver = function (e) {
  preventDefaults(e)
  highlight(e)
}
const handleDragLeave = function (e) {
  preventDefaults(e)
  unhighlight(e)
}
const handleDrop = function (e) {
  preventDefaults(e)
  unhighlight(e)
  const items = e.dataTransfer.items
  // let files = dt.files
  const dropId = targetDropArea(e).id
  let pageName = dropId.split('_')
  const type = pageName.shift()
  pageName = pageName.join('_')
  if (type === 'existingPageUploader') {
    handleUploadedFiles(pageName, items)
  } else {
    handleNewpageUpload(items)
  }
}
const preventDefaults = function (e) {
  e.preventDefault()
  e.stopPropagation()
}
const highlight = function (e) {
  targetDropArea(e).classList.add('highlight')
}
const unhighlight = function (e) {
  targetDropArea(e).classList.remove('highlight')
}
const targetDropArea = function (e) {
  var target = e.target
  if (!target.className.includes('drop-area')) {
    target = target.parentElement
  }
  if (!target.className.includes('drop-area')) console.log('akkkhhh - should iterate')
  return target
}

// Handle Uploads
const handleNewpageUpload = function (items) {
  const newItems = [] // newItems is used cause dataTransfer items dont persist in promises
  let mainFile = null
  if (items) {
    for (var i = 0; i < items.length; i++) {
      if (items[i].kind === 'file') {
        const file = items[i].getAsFile()
        const ext = extFromFileName(file.name)
        if (ext === 'html' && !mainFile) {
          mainFile = file
        } else {
          newItems.push({ kind: 'copiedfile', file: items[i].getAsFile() })
        }
      } else {
        console.warn('Non file was dropped?? SNBH ', items[i].getAsFile())
      }
    }
    const fullName = mainFile ? ('drafts/' + mainFile.name) : null
    let pageDetails = getFromList(fullName, 'name', pages)
    if (!mainFile) {
      document.getElementById('allMedia').scrollIntoView()
      showError(null, 'Uploading as media', 2000)
      handleUploadedFiles(null, items)
    } else if (pageDetails) { // mainfile already exists (user has dropped in the main area, but it's okay)
      handleUploadedFiles(fullName, items)
    } else { // No pageDetails
      pageDetails = { name: fullName, type: 'main', js: [], css: [], update: new Date().getTime() }
      pages.push(pageDetails)

      const pageDiv = createAndAppendPageDiv(fullName, true)
      drawPageDetails(fullName)
      let steps = 0

      freepr.feps.postquery({ collection: 'pages', q: { name: fullName } })
        .then(queryResults => {
          // check to make sure it doesnt already exist
          if (queryResults && queryResults.length > 0) {
            throw new Error('Main file already exists. Best to update pages by dropping the file in the page box.')
          }
          steps++ // 1
          return freepr.ceps.create(pageDetails, { collection: 'pages' })
        })
        .then(writeResults => {
          if (writeResults && writeResults.error) {
            throw new Error('Error creating page ' + writeResults.error + ' - ' + writeResults.message)
          }
          pageDetails._id = writeResults._id
          steps++ // 2
          return freezr.feps.upload(mainFile, { targetFolder: 'drafts' })
        })
        .then(uploadResults => {
          steps++ // 3
          if (newItems.length > 0) return handleUploadedFiles(fullName, newItems)
          showError(null, 'Successfully created' + fullName, 2000)
          return null
        })
        .catch(error => {
          if (steps <= 1) {
            pages.pop()
            const parent = pageDiv.parentNode
            parent.removeChild(pageDiv)
          }
          if (steps === 2) pageDetails.error = true
          showError(null, 'There was an error uploading the file: ' + fullName + ': ' + error.message)
        })
    }
  }
}
const handleUploadedFiles = function (pageName, items) {
  let pageDetails = getFromList(pageName, 'name', pages)
  if (pageName && !pageDetails) {
    showError('error finding page ' + pageName)
  } else if (items) {
    if (!pageName) pageDetails = { type: 'media' }
    // Use DataTransferItemList interface to access the file(s)
    for (var i = 0; i < items.length; i++) {
      // If dropped items aren't files, reject them

      if (items[i].kind === 'file') { // directly for handleUploadedFiles
        const file = items[i].getAsFile()
        handleUploadedFile(pageDetails, file)
      } else if (items[i].kind === 'copiedfile') { // from handleNewpageUpload - used because dataTransfer items dont persist in promises
        const file = items[i].file
        handleUploadedFile(pageDetails, file)
      } else {
        console.warn('Non file was dropped?? ', items[i])
      }
    }
  }
}
const handleUploadedFile = function (pageDetails, file) {
  // if no pageDetails are provided, then it is assumed it is a media file - ie an externam resource
  const ext = extFromFileName(file.name)
  const type = (pageDetails.type && pageDetails.type === 'media')
    ? 'media'
    : 'file'
  if (!ACCEPTED_FILE_TYPES.includes(ext.toLowerCase())) {
    showError(pageDetails.name, 'cannot upload file of extension ext ' + ext)
  // } else if (ext === 'html ' && pageDetails.name !== fullFileName){
  //  showError(pageDetails.name, 'cannot upload html files for other pages - only ' + pageDetails.name)
  } else if (type === 'media') {
    const allMediaDiv = dg.el('allMedia')
    const fileDiv = drawMediaDetails({ _id: ('media/' + file.name), type: 'media' }, false)
    allMediaDiv.insertBefore(fileDiv, allMediaDiv.firstChild)
    uploadFile({ type: 'media' }, file)
  } else {
    if (isJSorCSS(file.name)) {
      const fullFileName = fullDraftNameFromFile(file)
      let fileDetails = getFromList(fullFileName, 'name', pageDetails[ext])
      if (!fileDetails) {
        fileDetails = { name: fullFileName, updated: new Date().getTime() }
        dg.el(ext + '_' + pageDetails.name).appendChild(drawJsCssFileDiv(pageDetails, fileDetails))
      }
    }
    uploadFile(pageDetails, file)
    // upload each file and update the page data and upload the page data
  }
}

const uploadFile = function (pageDetails, file) {
  const isMediaType = (pageDetails && pageDetails.type === 'media')
  const fullFileName = isMediaType ? ('media/' + file.name) : fullDraftNameFromFile(file)
  const isMainPage = (fullFileName === pageDetails.name)
  const fileDiv = fileDivFrom(pageDetails, fullFileName)
  let fileDetails
  let mediaDetails

  const fileWrite = { targetFolder: (isMediaType ? 'media' : 'drafts') }
  if (isMediaType) fileWrite.data = { type: 'media' }

  freepr.feps.upload(file, fileWrite)
    .then(uploadResults => {
      if (!isMediaType) {
        const ext = extFromFileName(fullFileName)
        if (!pageDetails[ext]) pageDetails[ext] = []
        fileDetails = getFromList(fullFileName, 'name', pageDetails[ext])
        if (!fileDetails) {
          fileDetails = { name: fullFileName, updated: new Date().getTime() }
          pageDetails[ext].push(fileDetails)
        }
        fileDetails.update = new Date().getTime()
        if (pageDetails.published) pageDetails.postPublishFiles = true
        return freepr.ceps.update(pageDetails, { collection: 'pages' })
      } else {
        mediaDetails = getFromList(fullFileName, 'name', allMedia)
        if (!mediaDetails) {
          mediaDetails = { _id: fullFileName, type: 'media' }
          allMedia.push(mediaDetails)
        }
        if (!mediaDetails._date_modified) mediaDetails._date_modified = new Date().getTime() // also inupload resilts
        return null
      }
    })
    .then(updateResults => {
      if (isMainPage) {
        console.log('successfully updated file ')
      } else if (isMediaType) {
        fileDiv.innerHTML = ''
        fileDiv.appendChild(drawMediaDetails(mediaDetails, true))
        fileDiv.style.border = '2px dashed green'
      } else if (fileDiv && !isMainPage && !isMediaType) {
        reDrawUpdatedFileItem(fileDetails, pageDetails)
        const removePageButt = dg.el('removePage_' + pageDetails.name)
        if (removePageButt) removePageButt.style.display = 'none'
      } else if (!isMainPage && !isMediaType) {
        console.warn('error getting fileDiv for ', { pageDetails, fullFileName })
      }
      if (isJSorCSS(fullFileName)) {
        updatePagesWithSameFiles(fullFileName, pageDetails, 'update')
        // comnsole.log todo check if the mediafile was previously uploaded and remove that
        return null
      } else {
        return null
      }
    })
    .catch(error => {
      console.warn(error)
      showError(pageDetails.name, error.message)
    })
}
const updatePagesWithSameFiles = function (fullFileName, pageToIgnore, fieldToUpdate) {
  if (!['update', 'published'].includes(fieldToUpdate)) {
    console.error(fieldToUpdate + ' cannot be used here - pnly updtae and published')
    return null
  }
  pages.forEach(pageDetails => {
    var gotFileDetails
    if (pageToIgnore.name !== pageDetails.name) {
      const ext = extFromFileName(fullFileName)
      if (pageDetails[ext] && pageDetails[ext].length > 0) { // eg if ext === 'html'
        pageDetails[ext].forEach(fileDetails => {
          if (fileDetails.name === fullFileName) {
            fileDetails[fieldToUpdate] = new Date().getTime()
            gotFileDetails = fileDetails // should only happen once
          }
        })
      }
      if (gotFileDetails) {
        freezr.ceps.update(pageDetails, { collection: 'pages' }, function (err, ret) {
          if (err) {
            console.error('could not update ', err)
          } else {
            reDrawUpdatedFileItem(gotFileDetails, pageDetails, 'green')
          }
        })
      }
    }
  })
}
const findPagesWithFile = function (fullFileName, ignoreThisPage) {
  var list = []
  pages.forEach(pageDetails => {
    if (ignoreThisPage && ignoreThisPage.name !== pageDetails.name) {
      const ext = extFromFileName(fullFileName)
      pageDetails[ext].forEach(fileDetails => {
        if (fileDetails.name === fullFileName) list.push(pageDetails)
      })
    }
  })
  return list
}

const publishPage = function (mainPage) {
  showError(null, '', 1)
  freezr.perms.getAppPermissions(function (err, msg) {
    if (err) {
      showError(null, 'Could not connect to server')
      console.warn(err)
    } else if (!msg || msg.length === 0) {
      showError(null, 'Please grant the permission first')
    } else {
      const pagesToPublish = [{ name: mainPage, type: 'mainPage' }]
      const pageDetails = getFromList(mainPage, 'name', pages)
      if (!pageDetails) return showError(null, 'could not find page details')

      if (pageDetails.css) {
        pageDetails.css.forEach(item => pagesToPublish.push(item))
      }

      if (pageDetails.js) pageDetails.js.forEach(item => pagesToPublish.push(item))
      // todo - also check if file has been updated since last publish date

      pagesToPublish.forEach(pageObject => publishFile(pageObject, mainPage))
    }
  })
}
const publishFile = function (pageObj, mainPage) {
  const isHtmlMainPage = (pageObj.type === 'mainPage')
  const fullName = pageObj.name
  const fileName = fullName.split('/').pop()
  var targetFolder = fullName.split('/')
  targetFolder.pop()
  targetFolder[0] = 'public'
  targetFolder = targetFolder.join('/')
  const newFullName = targetFolder + '/' + fileName
  const pageDetails = getFromList(mainPage, 'name', pages)
  const pageRequest = new Request('/feps/fetchuserfiles/com.salmanff.orbit/' + freezrMeta.userId + '/' + fullName)
  return fetch(pageRequest, {
    headers: { Authorization: ('Bearer ' + freezr.utils.getCookie('app_token_' + freezrMeta.userId)) }
  })
    .then(response => response.text())
    .then(contents => {
      // pubish the js and the css
      const blob = new Blob([contents], { type: 'text/plain' })
      const file = new File([blob], fileName, { type: 'text/plain' })
      return freezr.feps.upload(file, { targetFolder, doNotOverWrite: false })
    })
    .then(uploadResults => {
      const id = newFullName
      let publicid = fileName

      if (!isHtmlMainPage) {
        publicid = '@' + freezrMeta.userId + '/com.salmanff.orbit.files/' + publicid
        // TODO CHECK PORDER - fullName first or app?
      } else {
        if (!freezrMeta.adminUser && !freezrMeta.publisherUser) publicid = '@' + freezrMeta.userId + '/' + publicid
        publicid = publicid.split('.')
        publicid.pop()
        publicid = publicid.join('.')
      }
      pageObj.publicid = publicid

      const options = { name: 'publish_file', grant: true, doNotList: true, publicid }

      if (isHtmlMainPage) {
        const pageDetails = getFromList(fullName, 'name', pages)
        options.isHtmlMainPage = true
        options.fileStructure = pageDetails
        pageDetails.publicid = publicid
      }
      return freepr.perms.shareServableFile(id, options)
    })
    .then(resp => {
      pageObj.published = new Date().getTime()
      if (isHtmlMainPage) pageDetails.published = new Date().getTime()
      return freepr.ceps.update(pageDetails, { collection: 'pages' })
    })
    .then(resp => {
      if (isHtmlMainPage) {
        const pageOuter = dg.el('page_' + pageDetails.name, { clear: true })
        drawPageDetails(pageDetails.name)
        pageOuter.style.border = '2px solid green'
      }
      updatePagesWithSameFiles(fullName, pageDetails, 'update')
      return null
    })
    .catch(e => {
      console.warn('errir in piub of ' + fullName, e)
      showError(null, 'There was an error publishing ' + fullName + '. Try again.')
    })
}
const unpublish = function (name) {
  const fileName = name.split('/').pop()
  var targetFolder = name.split('/')
  targetFolder.pop()
  targetFolder[0] = 'public'
  targetFolder = targetFolder.join('/')

  const id = targetFolder + '/' + fileName
  let publicid = fileName.split('.')
  publicid.pop()
  publicid = publicid.join('.')
  const pageDetails = getFromList(name, 'name', pages)

  freepr.perms.shareServableFile(id, { name: 'publish_file', grant: false, publicid })
    .then(resp => {
      pageDetails.published = null
      pageDetails.publicid = null
      pageDetails.postPublishFiles = false
      return freepr.ceps.update(pageDetails, { collection: 'pages' })
    })
    .then(resp => {
      dg.el('page_' + pageDetails.name, { clear: true })
      drawPageDetails(pageDetails.name)
      const exts = ['js', 'css']
      exts.forEach(ext => {
        pageDetails[ext].forEach(fileItem => {
          const pagesWithFile = findPagesWithFile(fileItem.name, pageDetails)
          var pagesWithFilePublished = []
          if (pagesWithFile.length > 0) {
            pagesWithFile.forEach(otherPage => {
              if (otherPage.published) pagesWithFilePublished.push(otherPage)
            })
          }
          if (pagesWithFilePublished.length === 0) {
            const fullName = fileItem.name
            var newFullName = fullName.split('/')
            newFullName[0] = 'public'
            newFullName = newFullName.join('/')
            const options = { name: 'publish_file', grant: false, publicid: fileItem.publicid }
            freezr.perms.shareServableFile(newFullName, options, function (err, resp) {
              if (err) showError(null, 'could not unshare ' + newFullName)
              freezr.feps.delete(newFullName, { collection: 'files' }, function (err, resp) {
                if (err) showError(null, 'could not delete ' + newFullName)
                fileItem.published = null
                fileItem.publicId = null
                freezr.ceps.update(pageDetails, { collection: 'pages' }, function (err, resp) {
                  if (err) showError(null, 'Error updating details in page for file ' + newFullName)
                  reDrawUpdatedFileItem(fileItem, pageDetails)
                })
              })
            })
          } else {
            reDrawUpdatedFileItem(fileItem, pageDetails, 'red')
          }
        })
      })
    })
    .catch(e => {
      console.warn(e)
    })
}

const togglePublishFile = function (innerDiv, fileObj) {
  const doPublish = !fileObj.published
  const publicid = '@' + freezrMeta.userId + '/com.salmanff.orbit.files/' + fileObj._id
  const options = { name: 'publish_file', grant: doPublish, doNotList: true, publicid }

  freepr.perms.shareServableFile(fileObj._id, options)
    .then(resp => {
      fileObj.published = doPublish ? new Date().getTime() : null
      fileObj.publicid = doPublish ? publicid : null
      return freepr.feps.update(fileObj, { collection: 'files' })
    })
    .then(resp => {
      const parent = innerDiv.parentNode
      parent.removeChild(innerDiv)
      parent.appendChild(drawMediaDetails(fileObj, true))
      parent.style.border = doPublish ? '1px solid green' : '1px dashed red'
      return null
    })
    .catch(e => {
      console.warn('error in pub of ', { fileObj })
      console.warn(e)
    })
}
const removeFile = function (innerDiv, fileObj) {
  if (fileObj.published) {
    showError(null, 'You need to unpublish before deleting files.')
  } else {
    freezr.feps.delete(fileObj._id, { collection: 'files' }, function (err, resp) {
      if (err) {
        showError(null, 'Error removing file: ' + fileObj._id + ': ' + JSON.stringify(err))
      } else {
        const theId = fileObj._id
        for (var i = allMedia.length - 1; i >= 0; i--) {
          if (allMedia[i]._id === theId) {
            allMedia.splice(i, 1)
          }
        }
        if (innerDiv && innerDiv.parentNode) {
          const theParent = innerDiv.parentNode
          theParent.innerHTML = 'Removed ' + theId
          theParent.style.border = '1px red solid'
        }
      }
    })
  }
}
const removeJsCssFile = function (innerDiv, fileObj, pageDetails) {
  const publicid = '@' + freezrMeta.userId + '/com.salmanff.orbit.files/' + fileObj._id
  const options = { name: 'publish_file', grant: false, publicid }

  const fileId = fileObj.name

  const otherPagesWithFile = findPagesWithFile(fileId, pageDetails)
  if (otherPagesWithFile.length > 0) {
    removeFileDetailsFromPage(fileId, pageDetails, innerDiv)
  } else {
    freezr.perms.shareServableFile(fileId, options, function (err, resp) {
      if (err) {
        console.warn('need to ignore err if it was unpublished', err)
      }
      freezr.feps.delete(fileId, { collection: 'files' }, function (err, resp) {
        if (err) {
          console.warn('need to ignore err if it was already removed', err)
        }
        const publicFileId = fileId.replace('drafts/', 'public/')
        freezr.feps.delete(publicFileId, { collection: 'files' }, function (err, resp) {
          if (err) {
            console.warn('need to ignore err if it was already removed', publicFileId, err)
          }
          removeFileDetailsFromPage(fileId, pageDetails, innerDiv)
        })
      })
    })
  }
}
const removeFileDetailsFromPage = function (fileId, pageDetails, innerDiv) {
  const ext = extFromFileName(fileId)
  for (let i = pageDetails[ext].length - 1; i >= 0; i--) {
    let found = false
    if (pageDetails[ext][i].name === fileId) {
      pageDetails[ext].splice(i, 1)
      found = true
    }
    if (!found) console.warn('strange internal error not finding file details ', { fileId, pageDetails })
  }
  freezr.ceps.update(pageDetails, { collection: 'pages' }, function (err, resp) {
    innerDiv.parentElement.innerHTML = (err ? 'error removing' : 'Removed ') + fileId
    if (pageDetails.js.length === 0 && pageDetails.css.length === 0) {
      const removePageButt = dg.el('removePage_' + pageDetails.name)
      if (removePageButt) removePageButt.style.display = 'inline-block'
    }
  })
}
const removePage = function (pageName) {
  const pageDetails = getFromList(pageName, 'name', pages)
  if ((pageDetails.js && pageDetails.js.length > 0) || (pageDetails.css && pageDetails.css.length > 0)) {
    showError(null, 'Cannot delete a page that has css or js elements')
  } else if (pageDetails.published) {
    showError(null, 'Cannot delete a page that is published')
  } else {
    const theName = pageDetails.name
    let fileErr = false
    freezr.feps.delete(theName, { collection: 'files' }, function (err, resp) {
      if (err) {
        console.warn('Error removing html file for page', err)
        fileErr = true
      }
      freezr.feps.delete(pageDetails._id, { collection: 'pages' }, function (err, resp) {
        if (err) {
          showError(null, 'Error removing page details')
        } else {
          for (var i = pages.length - 1; i >= 0; i--) {
            if (pages[i].name === theName) pages.splice(i, 1)
          }
          const pageDiv = dg.el('page_' + theName)
          if (pageDiv) pageDiv.innerHTML = 'Removed Page : ' + theName + (fileErr ? ' though there was a problem remvoing the file.' : '')
        }
      })
    })
  }
}

const showError = function (pageName, message, timer) {
  console.log('error: ', { pageName, message })
  const mainBox = document.getElementById('mainErrorBox')
  mainBox.innerText = mainBox.innerText + (message || ' error ') + ' \n'
  mainBox.style.display = 'block'
  if (timer) {
    setTimeout(function () { mainBox.innerText = ''; mainBox.style.display = 'none' }, timer)
  }
}

const getFromList = function (value, attr, list) {
  let hit = null
  list.forEach((item) => {
    if (item[attr] === value) hit = item
  })
  return hit
}
const extFromFileName = function (fileName) {
  return fileName.split('.').pop()
}
const remove1stPathEl = function (originalPath) {
  var newpath = originalPath.split('/')
  newpath.shift()
  return newpath.join('/')
}
const removeExtension = function (fileName) {
  var shortName = fileName.split('.')
  shortName.pop()
  return shortName.join('.')
}
const isJSorCSS = function (fileName) {
  const ext = extFromFileName(fileName)
  return ['js', 'css'].includes(ext)
}
