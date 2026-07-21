import 'bootstrap/dist/css/bootstrap.min.css';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './components/App.jsx';

// The mounting call has no component form; everything rendered from <App/>
// down is a React.Component class. No hooks anywhere in the UI.
createRoot(document.getElementById('root')).render(<App />);
