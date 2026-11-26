import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import AlbumPanel from './AlbumPanel'
import ContentManagementPage from './ContentManagementPage'
import './index.css'

const location = window.location
const legacyFeature = location.pathname === '/home/feature.html' ? new URLSearchParams(location.search).get('feature') : null
const albumPage = location.pathname === '/home/album' || legacyFeature === 'album'
const momentsPage = location.pathname === '/home/moments' || legacyFeature === 'moments'
const heartbeatPage = location.pathname === '/home/heartbeat' || legacyFeature === 'heartbeat'

if (albumPage) document.title = '相册 · estómago'
if (momentsPage) document.title = '朋友圈 · estómago'
if (heartbeatPage) document.title = '心跳 · estómago'

const page = albumPage ? <AlbumPanel initialTab="photos" onClose={() => location.assign('/')} />
  : momentsPage ? <ContentManagementPage mode="moments" />
  : heartbeatPage ? <ContentManagementPage mode="heartbeat" /> : <App />

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    {page}
  </React.StrictMode>,
)
