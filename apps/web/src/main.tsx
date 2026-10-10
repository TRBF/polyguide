import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { SensorDebug } from './guidance/SensorDebug';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {location.pathname === '/debug/sensors' ? <SensorDebug /> : <App />}
  </StrictMode>,
);
