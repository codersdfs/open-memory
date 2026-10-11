import { createRoot } from 'react-dom/client';
import App from './App';
import './styles/tokens.css';
import './styles/base.css';

const el = document.getElementById('root');
if (!el) throw new Error('index.html is missing #root');
createRoot(el).render(<App />);
