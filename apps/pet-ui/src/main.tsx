import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './ui';
import './style.css';
import './detail.css';
import './pet.css';
import './pet-interaction.css';
import './fish.css';

createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>);
