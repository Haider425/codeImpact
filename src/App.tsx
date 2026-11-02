import { Routes, Route } from 'react-router'
import Analysis from './pages/Analysis'
import Dashboard from './pages/Dashboard'
import Demo from './pages/Demo'

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Dashboard />} />
      <Route path="/demo" element={<Demo />} />
      <Route path="/analyses/:id" element={<Analysis />} />
    </Routes>
  )
}
