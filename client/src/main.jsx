import 'bootstrap/dist/css/bootstrap.min.css';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './components/App.jsx';

// The only file that is not a class: the ReactDOM mounting call has no
// component form. Everything rendered from <App/> down is a React.Component
// class — class components only, no hooks anywhere in the UI (SPEC.md §4).
createRoot(document.getElementById('root')).render(<App />);
