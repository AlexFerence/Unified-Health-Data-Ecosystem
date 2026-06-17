// WebSocket connection
let ws = null;
let reconnectInterval = null;
let lastChartData = null; // Cache for the last displayed chart

// Theme palettes
const themes = {
    palette1: {
        'charcoal-blue': '#264653',
        'verdigris': '#2a9d8f',
        'tuscan-sun': '#e9c46a',
        'sandy-brown': '#f4a261',
        'burnt-peach': '#e76f51',
        'verdigris-dark': '#248277',
        'burnt-peach-dark': '#d35839'
    },
    palette2: {
        'charcoal-blue': '#335c67',
        'verdigris': '#e09f3e',
        'tuscan-sun': '#fff3b0',
        'sandy-brown': '#9e2a2b',
        'burnt-peach': '#540b0e',
        'verdigris-dark': '#c8892e',
        'burnt-peach-dark': '#3d0808'
    }
};

// Current theme
let currentTheme = localStorage.getItem('theme') || 'palette1';

// Apply theme
function applyTheme(themeName) {
    const theme = themes[themeName];
    const root = document.documentElement;

    Object.keys(theme).forEach(key => {
        root.style.setProperty(`--${key}`, theme[key]);
    });

    currentTheme = themeName;
    localStorage.setItem('theme', themeName);
}

// Toggle theme
function toggleTheme() {
    const newTheme = currentTheme === 'palette1' ? 'palette2' : 'palette1';
    applyTheme(newTheme);

    // Update chart colors if there's a cached chart
    if (lastChartData) {
        // Just log, the chart will use new colors on next display
        console.log('Theme changed. Next chart will use new colors.');
    }
}

// DOM elements
const chatMessages = document.getElementById('chat-messages');
const logsContainer = document.getElementById('logs-container');
const messageInput = document.getElementById('message-input');
const sendButton = document.getElementById('send-button');
const clearLogsButton = document.getElementById('clear-logs-button');
const clearChatButton = document.getElementById('clear-chat-button');
const lastChartButton = document.getElementById('last-chart-button');
const themeToggle = document.getElementById('theme-toggle');

// Initialize
function init() {
    // Apply saved theme
    applyTheme(currentTheme);

    // Last Chart button starts disabled until a chart is received
    if (lastChartButton) {
        lastChartButton.disabled = true;
    }

    connectWebSocket();
    setupEventListeners();
}

// Connect to WebSocket
function connectWebSocket() {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}`;

    addLog('info', `Connecting to ${wsUrl}...`);

    ws = new WebSocket(wsUrl);

    ws.onopen = () => {
        addLog('success', 'Connected to server');
        sendButton.disabled = false;
        if (reconnectInterval) {
            clearInterval(reconnectInterval);
            reconnectInterval = null;
        }
    };

    ws.onmessage = (event) => {
        try {
            const data = JSON.parse(event.data);
            handleMessage(data);
        } catch (error) {
            console.error('Error parsing message:', error);
            addLog('error', `Error parsing message: ${error.message}`);
        }
    };

    ws.onerror = (error) => {
        console.error('WebSocket error:', error);
        addLog('error', 'WebSocket error occurred');
    };

    ws.onclose = () => {
        addLog('error', 'Disconnected from server');
        sendButton.disabled = true;

        // Try to reconnect every 3 seconds
        if (!reconnectInterval) {
            reconnectInterval = setInterval(() => {
                addLog('info', 'Attempting to reconnect...');
                connectWebSocket();
            }, 3000);
        }
    };
}

// Handle incoming messages
function handleMessage(data) {
    console.log('📨 Received message:', data.type, data);

    switch (data.type) {
        case 'log':
            if (typeof data.message === 'string' && data.message.startsWith('Calling tool:')) {
                break;
            }
            if (typeof data.message === 'string' && data.message.startsWith('User:')) {
                addLog('tool', data.message);
                break;
            }
            addLog(data.level || 'info', data.message);
            break;
        case 'tool_use':
            // Suppress tool invocation/input logs; keep only tool results in the UI.
            break;
        case 'user_message':
            // User message is already displayed when sent, skip duplicate
            break;
        case 'agent_response':
            addChatMessage('agent', data.message);
            break;
        case 'chart':
            console.log('📊 Chart message received!');
            console.log('📊 Chart data:', JSON.stringify(data.data, null, 2));

            if (!data.data) {
                console.error('❌ No chart data provided');
                addLog('error', 'Chart data is missing');
                return;
            }

            try {
                addChart(data.data);
                addLog('success', `Chart opened: ${data.data.title || 'Untitled'}`);
            } catch (error) {
                console.error('❌ Failed to display chart:', error);
                addLog('error', `Chart display error: ${error.message}`);
            }
            break;
        case 'agent_thinking':
            addLog('tool', 'Agent is thinking...');
            break;
        case 'error':
            addLog('error', data.message);
            break;
        default:
            console.log('⚠️ Unknown message type:', data);
    }
}

// Add chat message
function addChatMessage(sender, content) {
    // Hide loading indicator when agent responds
    if (sender === 'agent') {
        hideLoadingIndicator();
    }

    // Remove welcome message if it exists
    const welcomeMessage = chatMessages.querySelector('.welcome-message');
    if (welcomeMessage) {
        welcomeMessage.remove();
    }

    const messageDiv = document.createElement('div');
    messageDiv.className = `message ${sender}`;

    const headerDiv = document.createElement('div');
    headerDiv.className = 'message-header';
    headerDiv.textContent = sender === 'user' ? 'You' : 'Agent';

    const contentDiv = document.createElement('div');
    contentDiv.className = 'message-content';

    // Render markdown for agent messages
    if (sender === 'agent') {
        contentDiv.innerHTML = marked.parse(content);
    } else {
        contentDiv.textContent = content;
    }

    messageDiv.appendChild(headerDiv);
    messageDiv.appendChild(contentDiv);
    chatMessages.appendChild(messageDiv);

    // Limit chat history to last 10 messages (to save tokens)
    const allMessages = chatMessages.querySelectorAll('.message');
    const MAX_MESSAGES = 10;
    if (allMessages.length > MAX_MESSAGES) {
        // Remove oldest messages
        const messagesToRemove = allMessages.length - MAX_MESSAGES;
        for (let i = 0; i < messagesToRemove; i++) {
            allMessages[i].remove();
        }
        addLog('info', `Removed ${messagesToRemove} old message(s) to save tokens`);
    }

    // Scroll to bottom
    chatMessages.scrollTop = chatMessages.scrollHeight;
}

// Add chart as modal overlay
function addChart(chartData) {
    console.log('📊 addChart called with:', chartData);

    try {
        // Cache the chart data
        lastChartData = chartData;

        // Enable the "Last Chart" button
        if (lastChartButton) {
            lastChartButton.disabled = false;
        }

        // Remove any existing chart overlay
        const existingOverlay = document.querySelector('.chart-overlay');
        if (existingOverlay) {
            console.log('Removing existing overlay');
            existingOverlay.remove();
        }

        // Validate chart data
        if (!chartData || !chartData.type || !chartData.labels || !chartData.datasets) {
            throw new Error('Invalid chart data structure');
        }

        console.log('Creating chart overlay...');

        // Create fullscreen backdrop overlay
        const overlay = document.createElement('div');
        overlay.className = 'chart-overlay';

        // Create modal container
        const modal = document.createElement('div');
        modal.className = 'chart-modal';

        // Create header with title and close button
        const header = document.createElement('div');
        header.className = 'chart-header';

        const title = document.createElement('h2');
        title.className = 'chart-title';
        title.textContent = chartData.title || 'Chart';

        const closeButton = document.createElement('button');
        closeButton.className = 'chart-close-button';
        closeButton.innerHTML = '&times;';
        closeButton.setAttribute('aria-label', 'Close chart');

        header.appendChild(title);
        header.appendChild(closeButton);

        // Create chart container
        const chartContainer = document.createElement('div');
        chartContainer.className = 'chart-container';

        const canvas = document.createElement('canvas');
        canvas.id = 'chart-canvas';
        chartContainer.appendChild(canvas);

        // Assemble modal
        modal.appendChild(header);
        modal.appendChild(chartContainer);
        overlay.appendChild(modal);
        document.body.appendChild(overlay);

        console.log('✅ Chart overlay added to DOM');

        // Close handlers
        const closeChart = () => {
            console.log('Closing chart overlay');
            overlay.classList.add('fade-out');
            setTimeout(() => {
                overlay.remove();
                addLog('info', 'Chart closed');
            }, 200);
        };

        closeButton.addEventListener('click', closeChart);

        // Close when clicking outside the modal
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) {
                closeChart();
            }
        });

        // Close with Escape key
        const handleEscape = (e) => {
            if (e.key === 'Escape') {
                closeChart();
                document.removeEventListener('keydown', handleEscape);
            }
        };
        document.addEventListener('keydown', handleEscape);

        // Create the chart with Chart.js
        console.log('Rendering chart with Chart.js...');

        // Get current color palette from CSS variables
        const root = document.documentElement;
        const colorPalette = [
            getComputedStyle(root).getPropertyValue('--verdigris').trim(),
            getComputedStyle(root).getPropertyValue('--burnt-peach').trim(),
            getComputedStyle(root).getPropertyValue('--sandy-brown').trim(),
            getComputedStyle(root).getPropertyValue('--tuscan-sun').trim(),
            getComputedStyle(root).getPropertyValue('--charcoal-blue').trim()
        ];

        const charcoalBlue = getComputedStyle(root).getPropertyValue('--charcoal-blue').trim();

        const chart = new Chart(canvas, {
            type: chartData.type,
            data: {
                labels: chartData.labels,
                datasets: chartData.datasets.map((dataset, index) => {
                    // Always use our color palette
                    const color = colorPalette[index % colorPalette.length];
                    const isBar = chartData.type === 'bar';
                    const backgroundColor = color + (isBar ? 'cc' : '33');

                    return {
                        ...dataset,
                        borderColor: color,
                        backgroundColor: backgroundColor,
                        borderWidth: 2,
                        pointRadius: isBar ? undefined : 4,
                        pointHoverRadius: isBar ? undefined : 6,
                        pointBackgroundColor: isBar ? undefined : color,
                        pointBorderColor: isBar ? undefined : '#fff',
                        pointBorderWidth: isBar ? undefined : 2,
                        tension: isBar ? undefined : 0.3,
                        borderRadius: isBar ? 4 : undefined,
                    };
                })
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                interaction: {
                    mode: 'index',
                    intersect: false
                },
                plugins: {
                    legend: {
                        display: true,
                        position: 'top',
                        labels: {
                            padding: 15,
                            font: {
                                size: 13,
                                weight: '500'
                            },
                            usePointStyle: true,
                            pointStyle: 'circle'
                        }
                    },
                    tooltip: {
                        enabled: true,
                        backgroundColor: charcoalBlue,
                        padding: 12,
                        cornerRadius: 8,
                        titleFont: {
                            size: 14,
                            weight: 'bold'
                        },
                        bodyFont: {
                            size: 13
                        },
                        displayColors: true,
                        boxPadding: 6
                    }
                },
                scales: {
                    y: {
                        beginAtZero: false,
                        title: {
                            display: true,
                            text: chartData.yAxisLabel || 'Value',
                            color: charcoalBlue,
                            font: {
                                size: 14,
                                weight: '600'
                            }
                        },
                        grid: {
                            color: colorPalette[0] + '1a', // verdigris with 10% opacity
                            lineWidth: 1
                        },
                        ticks: {
                            color: charcoalBlue,
                            font: {
                                size: 12
                            }
                        }
                    },
                    x: {
                        grid: {
                            display: false
                        },
                        ticks: {
                            color: charcoalBlue,
                            font: {
                                size: 12
                            },
                            maxRotation: 45,
                            minRotation: 0
                        }
                    }
                }
            }
        });

        console.log('✅ Chart rendered successfully');
        addLog('success', `Chart displayed: ${chartData.title}`);

        return chart;
    } catch (error) {
        console.error('❌ Error creating chart:', error);
        addLog('error', `Failed to create chart: ${error.message}`);
        throw error;
    }
}

// Add log message
function addLog(level, message) {
    const logDiv = document.createElement('div');
    logDiv.className = `log-message ${level}`;

    const timestamp = new Date().toLocaleTimeString();
    const timestampSpan = document.createElement('span');
    timestampSpan.className = 'log-timestamp';
    timestampSpan.textContent = `[${timestamp}]`;

    const contentSpan = document.createElement('span');
    contentSpan.className = 'log-content';
    contentSpan.textContent = message;

    logDiv.appendChild(timestampSpan);
    logDiv.appendChild(contentSpan);
    logsContainer.appendChild(logDiv);

    // Scroll to bottom
    logsContainer.scrollTop = logsContainer.scrollHeight;

    // Limit log history to 1000 messages
    const logMessages = logsContainer.querySelectorAll('.log-message');
    if (logMessages.length > 1000) {
        logMessages[0].remove();
    }
}

// Show loading indicator
function showLoadingIndicator() {
    // Remove any existing loading indicator
    const existingLoader = document.querySelector('.loading-indicator');
    if (existingLoader) {
        existingLoader.remove();
    }

    // Remove welcome message if it exists
    const welcomeMessage = chatMessages.querySelector('.welcome-message');
    if (welcomeMessage) {
        welcomeMessage.remove();
    }

    const loaderDiv = document.createElement('div');
    loaderDiv.className = 'loading-indicator';
    loaderDiv.innerHTML = `
        <div class="loader-content">
            <div class="pulsing-dots">
                <div class="dot"></div>
                <div class="dot"></div>
                <div class="dot"></div>
            </div>
            <div class="loader-text">Agent is thinking<span class="dots"></span></div>
        </div>
    `;
    chatMessages.appendChild(loaderDiv);
    chatMessages.scrollTop = chatMessages.scrollHeight;
}

// Hide loading indicator
function hideLoadingIndicator() {
    const loader = document.querySelector('.loading-indicator');
    if (loader) {
        loader.classList.add('fade-out');
        setTimeout(() => loader.remove(), 300);
    }
}

// Send message
function sendMessage() {
    const message = messageInput.value.trim();
    if (!message || !ws || ws.readyState !== WebSocket.OPEN) {
        return;
    }

    // Display user message immediately
    addChatMessage('user', message);

    // Send to server
    ws.send(JSON.stringify({
        type: 'chat',
        message: message
    }));

    // Clear input
    messageInput.value = '';
    messageInput.focus();

    // Add log
    addLog('info', `Sent message: ${message}`);

    // Show loading indicator below the user's message
    showLoadingIndicator();
}

// Setup event listeners
function setupEventListeners() {
    sendButton.addEventListener('click', sendMessage);

    messageInput.addEventListener('keypress', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            sendMessage();
        }
    });

    clearLogsButton.addEventListener('click', () => {
        logsContainer.innerHTML = '';
        addLog('info', 'Logs cleared');
    });

    clearChatButton.addEventListener('click', () => {
        // Remove all messages and loading indicators
        chatMessages.innerHTML = '';

        // Show welcome message again
        const welcomeDiv = document.createElement('div');
        welcomeDiv.className = 'welcome-message';
        welcomeDiv.innerHTML = '<p>Welcome! Type a message below to chat with the agent.</p>';
        chatMessages.appendChild(welcomeDiv);

        addLog('success', 'Chat history cleared - session reset');
    });

    // Last Chart button - shows the cached chart
    if (lastChartButton) {
        lastChartButton.addEventListener('click', () => {
            if (lastChartData) {
                addLog('info', 'Displaying last chart...');
                try {
                    addChart(lastChartData);
                } catch (error) {
                    addLog('error', `Failed to display last chart: ${error.message}`);
                }
            }
        });
    }

    // Theme toggle
    if (themeToggle) {
        themeToggle.addEventListener('click', toggleTheme);
    }
}

// Start the app
init();
