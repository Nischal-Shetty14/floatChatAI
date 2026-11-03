import React, { useState, useRef, useEffect } from 'react';
import { Send, MessageSquare, X, Trash2, HelpCircle } from 'lucide-react';

const CHAT_STORAGE_KEY = 'floatchat-chat-session-v1';
const INITIAL_MESSAGE = {
  role: 'model',
  content: `🌊 **Hello! I am FloatChat AI**, your emergency crisis sentinel and marine intelligence analyst. \n\nI am synchronized with active **Tsunami Buoy Telemetry**, **Verified Shelters**, **Offline P2P Mesh Gateways**, and **SAR Rescue Operations**.\n\nAsk me for nearest shelters, evacuation safe routes, offline mesh relay steps, or multilingual survival instructions!`
};

function loadChatSession() {
  try {
    const saved = JSON.parse(sessionStorage.getItem(CHAT_STORAGE_KEY) || 'null');
    if (Array.isArray(saved) && saved.every((message) => message && ['model', 'user'].includes(message.role) && typeof message.content === 'string')) {
      return saved;
    }
  } catch {
    // Start a clean tab-scoped chat if stored session data is unavailable.
  }
  return [INITIAL_MESSAGE];
}

export default function FloatChatBot({ isOpen, onClose, activeBuoy }) {
  const [messages, setMessages] = useState(loadChatSession);
  const [inputMessage, setInputMessage] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [geminiMode, setGeminiMode] = useState('checking');
  const [geminiModel, setGeminiModel] = useState('');
  const [showSuggestions, setShowSuggestions] = useState(true);
  const chatEndRef = useRef(null);

  const SUGGESTIONS = [
    "Where is the nearest verified safe shelter?",
    "सुनामी आने पर क्या कदम उठाने चाहिए? (Hindi)",
    "புயல் பாதுகாப்பு வழிமுறைகள் என்ன? (Tamil)",
    "How does the offline Bluetooth mesh network relay SOS?",
    "Show AI resource distribution recommendations for relief warehouses.",
    "Are there any low oxygen or buoy pressure spikes?"
  ];

  useEffect(() => {
    if (!isOpen) return;
    fetch('/api/status')
      .then((response) => response.ok ? response.json() : null)
      .then((data) => {
        if (!data) {
          setGeminiMode('unavailable');
          return;
        }
        setGeminiMode(data.geminiConfigured ? 'configured' : 'fallback');
        setGeminiModel(data.geminiModel || '');
      })
      .catch(() => setGeminiMode('unavailable'));
  }, [isOpen]);

  useEffect(() => {
    try {
      sessionStorage.setItem(CHAT_STORAGE_KEY, JSON.stringify(messages));
    } catch {
      // The in-memory conversation remains usable if session storage is blocked.
    }
  }, [messages]);

  // Auto-scroll to bottom of chat
  useEffect(() => {
    if (chatEndRef.current) {
      chatEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [messages, isLoading]);

  // Handle message sending
  const sendMessage = async (text) => {
    if (!text.trim()) return;

    const userMessage = { role: 'user', content: text };
    setMessages(prev => [...prev, userMessage]);
    setInputMessage('');
    setIsLoading(true);

    try {
      const chatHistory = messages.map(m => ({
        role: m.role === 'model' ? 'model' : 'user',
        content: m.content
      }));

      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          message: text,
          chatHistory: chatHistory
        })
      });

      const data = await response.json();

      if (response.ok && data.message) {
        setGeminiMode(data.geminiConfigured ? 'active' : 'fallback');
        const detail = data.fallbackReason ? `\n\nGemini response detail: ${data.fallbackReason}` : '';
        setMessages(prev => [...prev, { role: 'model', content: `${data.message}${detail}` }]);
      } else {
        setGeminiMode('error');
        setMessages(prev => [...prev, { 
          role: 'model', 
          content: `⚠️ **Error communicating with server.** \n\nDetails: ${data.details || 'Unknown server error. Ensure backend is running.'}` 
        }]);
      }
    } catch (error) {
      console.error('Chat error:', error);
      setGeminiMode('unavailable');
      setMessages(prev => [...prev, { 
        role: 'model', 
        content: `⚠️ **Network error.** Please verify that the FloatChat backend server is running on port 5001.` 
      }]);
    } finally {
      setIsLoading(false);
    }
  };

  const handleSubmit = (e) => {
    e.preventDefault();
    sendMessage(inputMessage);
  };

  const clearChat = () => {
    setMessages([{ role: 'model', content: '🌊 Chat history cleared. Ready for a new FloatChat session.' }]);
  };

  // Custom Light Markdown Parser to native React elements
  const renderMessageText = (text) => {
    if (!text) return null;
    const lines = text.split('\n');
    const elements = [];
    let listItems = [];
    let keyCounter = 0;

    const formatBoldAndCode = (str) => {
      // sanitizes text and replaces md structures
      return str
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
        .replace(/\*(.*?)\*/g, '<em>$1</em>')
        .replace(/`(.*?)`/g, '<code>$1</code>');
    };

    const flushList = () => {
      if (listItems.length > 0) {
        elements.push(
          <ul key={`list-${keyCounter++}`} style={{ paddingLeft: '20px', margin: '8px 0 12px 0' }}>
            {listItems}
          </ul>
        );
        listItems = [];
      }
    };

    lines.forEach((line) => {
      const trimmed = line.trim();
      
      if (trimmed.startsWith('###')) {
        flushList();
        elements.push(<h4 key={keyCounter++} style={{ color: 'var(--color-primary)', fontSize: '15px', fontWeight: '700', marginTop: '12px', marginBottom: '6px' }}>{trimmed.replace('###', '').trim()}</h4>);
      } else if (trimmed.startsWith('##')) {
        flushList();
        elements.push(<h3 key={keyCounter++} style={{ color: 'var(--color-secondary)', fontSize: '16px', fontWeight: '800', marginTop: '14px', marginBottom: '8px' }}>{trimmed.replace('##', '').trim()}</h3>);
      } else if (trimmed.startsWith('-') || trimmed.startsWith('*')) {
        const itemContent = trimmed.replace(/^[-*]\s*/, '');
        listItems.push(
          <li key={`li-${keyCounter++}`} style={{ marginBottom: '4px', fontSize: '13.5px' }} dangerouslySetInnerHTML={{ __html: formatBoldAndCode(itemContent) }} />
        );
      } else if (trimmed === '') {
        flushList();
      } else {
        flushList();
        elements.push(
          <p key={keyCounter++} style={{ marginBottom: '10px', fontSize: '13.5px', lineHeight: '1.5' }} dangerouslySetInnerHTML={{ __html: formatBoldAndCode(trimmed) }} />
        );
      }
    });

    flushList(); // Make sure any trailing list elements are written out
    return elements;
  };

  return (
    <div className={`chatbot-drawer ${isOpen ? 'open' : ''}`}>
      {/* Header */}
      <div className="chatbot-header">
        <div style={{ display: 'flex', flexDirection: 'column', gap: '5px', minWidth: 0 }}>
          <div className="chatbot-title">
            <MessageSquare size={20} color="var(--color-primary)" />
            <span className="gradient-text">FloatChat Analyst</span>
          </div>
          <div className={`chat-mode-status ${geminiMode}`} role="status" aria-live="polite">
            {geminiMode === 'checking' && 'Checking assistant status…'}
            {geminiMode === 'configured' && `Gemini key loaded · ${geminiModel || 'model selected'} · awaiting request`}
            {geminiMode === 'active' && `Gemini active · ${geminiModel || 'configured model'}`}
            {geminiMode === 'fallback' && 'Rule-based, data-grounded fallback active'}
            {geminiMode === 'unavailable' && 'Backend status unavailable'}
            {geminiMode === 'error' && 'Chat request failed · retry when backend is available'}
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <button 
            className="btn-secondary" 
            onClick={clearChat} 
            title="Clear Chat History"
            style={{ padding: '6px', borderRadius: '6px', border: 'none', background: 'transparent' }}
          >
            <Trash2 size={16} color="var(--text-muted)" />
          </button>
          <button 
            className="btn-secondary" 
            onClick={onClose}
            style={{ padding: '6px', borderRadius: '6px', border: 'none', background: 'transparent' }}
          >
            <X size={18} color="white" />
          </button>
        </div>
      </div>

      {/* Message History */}
      <div className="chat-history">
        {messages.map((msg, index) => (
          <div key={index} className={`chat-msg ${msg.role}`}>
            {msg.role === 'model' ? (
              renderMessageText(msg.content)
            ) : (
              <p style={{ margin: 0 }}>{msg.content}</p>
            )}
          </div>
        ))}
        {isLoading && (
          <div className="chat-msg model" style={{ padding: '12px 18px', display: 'flex', alignItems: 'center', gap: '4px' }}>
            <span style={{ fontSize: '13px', color: 'var(--text-secondary)' }}>AI Oceanographer is thinking</span>
            <span style={{ display: 'flex', gap: '3px' }}>
              <span className="spinner" style={{ width: '10px', height: '10px', borderWidth: '1.5px', display: 'inline-block' }}></span>
            </span>
          </div>
        )}
        <div ref={chatEndRef} />
      </div>

      {/* Suggestions can be hidden independently of the conversation and input. */}
      {showSuggestions ? (
        <div className="chat-suggestions-section">
          <div className="chat-suggestions-heading">
            <span><HelpCircle size={12} /> Suggestion prompts:</span>
            <button type="button" className="chat-suggestions-toggle" onClick={() => setShowSuggestions(false)} aria-label="Hide suggestions" title="Hide suggestions">
              <X size={14} />
            </button>
          </div>
          <div className="suggestions-grid">
            {SUGGESTIONS.map((s, idx) => (
              <button
                key={idx}
                className="suggestion-btn"
                onClick={() => sendMessage(s)}
                disabled={isLoading}
              >
                {s}
              </button>
            ))}
          </div>
        </div>
      ) : (
        <div className="chat-suggestions-collapsed">
          <button type="button" className="chat-suggestions-toggle" onClick={() => setShowSuggestions(true)}>
            <HelpCircle size={13} /> Suggestions
          </button>
        </div>
      )}

      {/* Input Field Form */}
      <form onSubmit={handleSubmit} className="chat-input-area">
        <input 
          type="text"
          className="input-field chat-input"
          placeholder="Ask about ocean depth, salinity anomalies..."
          value={inputMessage}
          onChange={(e) => setInputMessage(e.target.value)}
          disabled={isLoading}
        />
        <button 
          type="submit" 
          className="btn-primary" 
          style={{ padding: '10px', borderRadius: '8px' }}
          disabled={!inputMessage.trim() || isLoading}
        >
          <Send size={16} />
        </button>
      </form>
    </div>
  );
}
