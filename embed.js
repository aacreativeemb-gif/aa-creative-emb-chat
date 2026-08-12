(function () {
  // Figure out where this script is hosted (the backend URL) so the iframe
  // and API calls point to the right place regardless of which site embeds it.
  var scriptTag = document.currentScript || (function () {
    var scripts = document.getElementsByTagName('script');
    return scripts[scripts.length - 1];
  })();
  var ORIGIN = new URL(scriptTag.src).origin;

  var style = document.createElement('style');
  style.textContent = `
    #aace-chat-bubble {
      position: fixed;
      bottom: 22px;
      right: 22px;
      width: 60px;
      height: 60px;
      border-radius: 50%;
      background: #2f6fed;
      color: white;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 26px;
      cursor: pointer;
      box-shadow: 0 6px 20px rgba(0,0,0,0.25);
      z-index: 999998;
      transition: transform 0.15s ease;
      border: none;
    }
    #aace-chat-bubble:hover { transform: scale(1.06); }

    #aace-chat-panel {
      position: fixed;
      bottom: 96px;
      right: 22px;
      width: 380px;
      height: 600px;
      max-height: 75vh;
      background: #0f1115;
      border-radius: 16px;
      overflow: hidden;
      box-shadow: 0 10px 40px rgba(0,0,0,0.35);
      z-index: 999999;
      display: none;
    }
    #aace-chat-panel iframe {
      width: 100%;
      height: 100%;
      border: none;
    }
    #aace-chat-close {
      position: absolute;
      top: 10px;
      right: 10px;
      width: 26px;
      height: 26px;
      border-radius: 50%;
      background: rgba(255,255,255,0.12);
      color: #fff;
      border: none;
      cursor: pointer;
      font-size: 14px;
      z-index: 2;
    }

    @media (max-width: 480px) {
      #aace-chat-panel {
        width: 100vw;
        height: 100vh;
        max-height: 100vh;
        bottom: 0;
        right: 0;
        border-radius: 0;
      }
    }
  `;
  document.head.appendChild(style);

  var bubble = document.createElement('button');
  bubble.id = 'aace-chat-bubble';
  bubble.setAttribute('aria-label', 'Open chat');
  bubble.textContent = '💬';
  document.body.appendChild(bubble);

  var panel = document.createElement('div');
  panel.id = 'aace-chat-panel';

  var closeBtn = document.createElement('button');
  closeBtn.id = 'aace-chat-close';
  closeBtn.textContent = '✕';
  panel.appendChild(closeBtn);

  var iframe = document.createElement('iframe');
  iframe.src = ORIGIN + '/index.html';
  iframe.allow = 'clipboard-write';
  panel.appendChild(iframe);

  document.body.appendChild(panel);

  var open = false;
  function togglePanel(forceOpen) {
    open = typeof forceOpen === 'boolean' ? forceOpen : !open;
    panel.style.display = open ? 'block' : 'none';
    bubble.textContent = open ? '✕' : '💬';
  }

  bubble.addEventListener('click', function () { togglePanel(); });
  closeBtn.addEventListener('click', function () { togglePanel(false); });
})();
