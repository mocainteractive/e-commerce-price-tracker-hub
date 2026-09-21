import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { MocaProvider } from './lib/MocaProvider';
import App from './App';
import './index.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <MocaProvider>
        <App />
      </MocaProvider>
    </BrowserRouter>
  </StrictMode>,
);
