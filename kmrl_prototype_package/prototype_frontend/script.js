// Enhanced Control Center Script with Fixed Layout and Re-entry System
const API_BASE = "http://127.0.0.1:5000";
const REFRESH_MS = 8000;
const HEALTH_UPDATE_MS = 30000; // Base cycle time
const EXIT_DELAY_MS = 10000; // 10 seconds before healthy train exits
const MAX_TRAINS_PER_TRACK = 1; // Only 1 train in repair at a time

// Time conversion: 3 seconds = 1 day = 24 hours
const SECONDS_PER_DAY = 3;
const HOURS_PER_SECOND = 8; // 1 real second = 8 simulation hours
const DAYS_TO_MINOR = 10; // 10 days = 30 seconds
const DAYS_TO_CRITICAL = 30; // 30 days = 90 seconds

// Variable track delays (in milliseconds)
const TRACK_DELAYS = {
  1: 1000,  // 1 second
  2: 5000,  // 5 seconds  
  3: 3000,  // 3 seconds
  4: 7000   // 7 seconds
};

// Healing times based on status (in seconds)
const HEALING_TIMES = {
  'critical': 30000,  // 30 seconds = 10 days = 240 hours
  'minor': 10000,     // 10 seconds = 3.3 days = 80 hours
  'healthy': 0        // Already healthy
};

// Track positions (adjusted for better alignment)
const TRACK_Y = { 1: 100, 2: 200, 3: 300, 4: 400 };

// Zone X positions (properly spaced)
const QUEUE_X_START = 60;   // Queue area start
const QUEUE_X_END = 160;    // Queue area end
const NEXT_TRAIN_X = 300;   // Next train position
const REPAIR_X = 550;       // Active repair position
const EXIT_X = 850;         // Exit area

let healthChart = null;
let currentScale = 1;
let localStatusData = [];
let backendStatusData = [];
let currentRecData = [];

// Track management
let trackAssignments = new Map(); // trainId -> track number
let trainsInRepair = new Map(); // track -> trainId (strictly one per track)
let trainQueue = []; // Trains waiting to enter
let nextTrainSlots = new Map(); // track -> trainId (next in line)
let exitingTrains = new Set(); // Trains that are exiting
let healingTrains = new Map(); // trainId -> {startTime, duration, track}
let trainDaysTracking = new Map(); // trainId -> {lastUpdate, totalDays}
let reEntryQueue = []; // Trains that need to re-enter after days expire
let isInitialLoad = true;

// Healing system
let healingCycleInProgress = false;
let currentHealingTrack = 1;

// Day tracking system
let dayTrackingInterval = null;

// Initialize on DOM load
document.addEventListener('DOMContentLoaded', () => {
  initializeApp();
  setupEventListeners();
  createParticles();
  animateBackground();
});

async function initializeApp() {
  showLoading();
  await refreshAll();
  setTimeout(() => hideLoading(), 1500);
  
  // Start systems after initial load
  setTimeout(() => {
    startDayTrackingSystem();
    startHealthImprovementSystem();
    startDepotManagementSystem();
  }, 2000);
  
  // Periodic refresh
  refreshInterval = setInterval(() => {
    if (!healingCycleInProgress) {
      refreshAll();
    }
  }, REFRESH_MS);
}

function showLoading() {
  document.getElementById('loading-overlay').classList.remove('hidden');
}

function hideLoading() {
  document.getElementById('loading-overlay').classList.add('hidden');
}

function setupEventListeners() {
  document.getElementById('zoom-in').addEventListener('click', () => {
    currentScale = Math.min(currentScale + 0.1, 1.5);
    updateYardScale();
  });
  
  document.getElementById('zoom-out').addEventListener('click', () => {
    currentScale = Math.max(currentScale - 0.1, 0.7);
    updateYardScale();
  });
  
  document.getElementById('refresh-yard').addEventListener('click', () => {
    animateRefresh();
    refreshAll();
  });
  
  document.getElementById('modal-close').addEventListener('click', closeModal);
  document.querySelector('.modal-backdrop').addEventListener('click', closeModal);
}

function updateYardScale() {
  const svg = document.getElementById('tracks-svg');
  const layer = document.getElementById('trains-layer');
  svg.style.transform = `scale(${currentScale})`;
  layer.style.transform = `scale(${currentScale})`;
  svg.style.transformOrigin = 'center center';
  layer.style.transformOrigin = 'center center';
}

function animateRefresh() {
  const btn = document.getElementById('refresh-yard');
  btn.style.animation = 'spin 0.5s ease';
  setTimeout(() => btn.style.animation = '', 500);
}

// Create floating particles
function createParticles() {
  const container = document.getElementById('particles');
  for (let i = 0; i < 50; i++) {
    const particle = document.createElement('div');
    particle.className = 'particle';
    particle.style.cssText = `
      position: absolute;
      width: ${Math.random() * 3 + 1}px;
      height: ${Math.random() * 3 + 1}px;
      background: rgba(0, 240, 255, ${Math.random() * 0.5 + 0.2});
      border-radius: 50%;
      left: ${Math.random() * 100}%;
      top: ${Math.random() * 100}%;
      animation: particleFloat ${Math.random() * 20 + 10}s linear infinite;
      animation-delay: ${Math.random() * 5}s;
    `;
    container.appendChild(particle);
  }
}

function animateBackground() {
  let hue = 0;
  setInterval(() => {
    hue = (hue + 1) % 360;
    document.documentElement.style.setProperty('--dynamic-hue', `${hue}deg`);
  }, 100);
}

// Day Tracking System with Re-entry
function startDayTrackingSystem() {
  console.log('Day tracking system with re-entry started');
  
  // Initialize tracking for all trains
  localStatusData.forEach(train => {
    if (!trainDaysTracking.has(train.train_id)) {
      trainDaysTracking.set(train.train_id, {
        lastUpdate: Date.now(),
        totalDays: train.days_until_next_service || 30,
        statusLastChanged: Date.now(),
        cycleCount: 0
      });
    }
  });
  
  // Update days every second
  dayTrackingInterval = setInterval(() => {
    updateTrainDays();
    checkForReEntry();
  }, 1000);
}

function updateTrainDays() {
  const now = Date.now();
  
  localStatusData.forEach(train => {
    // Skip if train is being healed
    if (healingTrains.has(train.train_id)) {
      return;
    }
    
    const tracking = trainDaysTracking.get(train.train_id);
    if (!tracking) return;
    
    // Only count down days if not in repair
    const inRepair = Array.from(trainsInRepair.values()).includes(train.train_id);
    if (inRepair) return;
    
    // Calculate elapsed time since last update
    const elapsedSeconds = (now - tracking.lastUpdate) / 1000;
    const elapsedDays = elapsedSeconds / SECONDS_PER_DAY;
    
    // Update days
    const newDays = Math.max(0, (tracking.totalDays || 0) - elapsedDays);
    tracking.totalDays = newDays;
    tracking.lastUpdate = now;
    
    // Update train data
    const trainIndex = localStatusData.findIndex(t => t.train_id === train.train_id);
    if (trainIndex !== -1) {
      localStatusData[trainIndex].days_until_next_service = Math.round(newDays);
      
      // Update status based on days remaining
      const previousStatus = train.fitness_status;
      let newStatus = previousStatus;
      
      if (newDays <= 0) {
        newStatus = 'Critical';
        // Add to re-entry queue if not already there
        if (!reEntryQueue.includes(train.train_id) && !inRepair) {
          console.log(`Train ${train.train_id} needs re-entry (0 days left)`);
          reEntryQueue.push(train.train_id);
        }
      } else if (newDays <= DAYS_TO_MINOR) {
        newStatus = 'Minor';
      } else {
        newStatus = 'Healthy';
      }
      
      if (newStatus !== previousStatus) {
        localStatusData[trainIndex].fitness_status = newStatus;
        console.log(`Train ${train.train_id} status changed: ${previousStatus} → ${newStatus} (${Math.round(newDays)} days left)`);
        updateTrainVisual(train.train_id, newStatus);
      }
    }
  });
  
  updateAllVisualizations();
}

function checkForReEntry() {
  // Process re-entry queue
  if (reEntryQueue.length > 0) {
    // Try to add trains back to main queue
    while (reEntryQueue.length > 0) {
      const trainId = reEntryQueue.shift();
      
      // Only re-queue if not already in queue or repair
      if (!trainQueue.includes(trainId) && 
          !Array.from(trainsInRepair.values()).includes(trainId) &&
          !Array.from(nextTrainSlots.values()).includes(trainId)) {
        
        console.log(`Re-queuing train ${trainId} for maintenance`);
        trainQueue.push(trainId);
        
        // Update train status to critical
        const trainIndex = localStatusData.findIndex(t => t.train_id === trainId);
        if (trainIndex !== -1) {
          localStatusData[trainIndex].fitness_status = 'Critical';
          localStatusData[trainIndex].days_until_next_service = 0;
        }
      }
    }
  }
}

function updateTrainVisual(trainId, newStatus) {
  const trainElement = document.querySelector(`.train[data-id="${trainId}"]`);
  if (trainElement) {
    const fitness = newStatus.toLowerCase();
    trainElement.className = `train ${fitness}`;
    
    // Update lights
    const lights = trainElement.querySelector('.train-lights');
    if (lights) {
      lights.className = `train-lights ${fitness}`;
    }
    
    // Add status change animation
    trainElement.style.animation = `statusChange 0.5s ease-out`;
    setTimeout(() => {
      trainElement.style.animation = '';
    }, 500);
  }
}

// Initialize depot positions
function initializeDepotPositions() {
  trackAssignments.clear();
  trainsInRepair.clear();
  nextTrainSlots.clear();
  trainQueue = [];
  exitingTrains.clear();
  healingTrains.clear();
  reEntryQueue = [];
  
  // Initialize tracks (empty initially)
  for (let track = 1; track <= 4; track++) {
    trainsInRepair.set(track, null);
    nextTrainSlots.set(track, null);
  }
  
  // Assign trains to positions
  localStatusData.forEach((train, index) => {
    if (index < 4) {
      // First 4 trains go to repair positions
      const track = index + 1;
      trackAssignments.set(train.train_id, track);
      trainsInRepair.set(track, train.train_id);
    } else if (index < 8) {
      // Next 4 trains as "next in line"
      const track = (index - 4) + 1;
      trackAssignments.set(train.train_id, track);
      nextTrainSlots.set(track, train.train_id);
    } else {
      // Rest go to queue
      trainQueue.push(train.train_id);
    }
  });
  
  console.log('Depot initialized:', {
    inRepair: Array.from(trainsInRepair.entries()),
    nextInLine: Array.from(nextTrainSlots.entries()),
    inQueue: trainQueue.length
  });
}

// Depot Management System
function startDepotManagementSystem() {
  console.log('Depot management system started');
  initializeDepotPositions();
  
  // Check for movements periodically
  setInterval(processDepotMovements, 2000);
}

function processDepotMovements() {
  // Process exits
  exitingTrains.forEach(trainId => {
    const trainData = localStatusData.find(t => t.train_id === trainId);
    if (trainData && trainData.exitTimer && Date.now() >= trainData.exitTimer) {
      performTrainExit(trainId);
    }
  });
  
  // Check healing progress
  healingTrains.forEach((healingInfo, trainId) => {
    const elapsed = Date.now() - healingInfo.startTime;
    const progress = Math.min(100, (elapsed / healingInfo.duration) * 100);
    
    updateHealingProgress(trainId, progress, healingInfo.duration - elapsed);
    
    if (elapsed >= healingInfo.duration) {
      completeHealing(trainId, healingInfo.track);
    }
  });
  
  // Ensure only one train per repair position
  for (let track = 1; track <= 4; track++) {
    const currentRepair = trainsInRepair.get(track);
    if (!currentRepair && !healingTrains.has(currentRepair)) {
      // Position is empty, move next train if available
      const nextTrain = nextTrainSlots.get(track);
      if (nextTrain) {
        moveNextTrainToRepair(track);
      }
    }
  }
}

function performTrainExit(trainId) {
  console.log(`Train ${trainId} exiting`);
  
  const track = trackAssignments.get(trainId);
  if (!track) return;
  
  const trainElement = document.querySelector(`.train[data-id="${trainId}"]`);
  if (trainElement) {
    // Animate exit
    trainElement.style.transition = 'all 2s ease-out';
    trainElement.style.left = `${EXIT_X}px`;
    trainElement.style.opacity = '0';
    
    setTimeout(() => {
      trainElement.remove();
      
      // Clear from repair position
      if (trainsInRepair.get(track) === trainId) {
        trainsInRepair.set(track, null);
      }
      
      trackAssignments.delete(trainId);
      exitingTrains.delete(trainId);
      
      // Move next train to repair position
      moveNextTrainToRepair(track);
      
      showExitNotification(trainId, track);
      
      // Start day countdown again for this train
      const tracking = trainDaysTracking.get(trainId);
      if (tracking) {
        tracking.cycleCount++;
        console.log(`Train ${trainId} completed cycle ${tracking.cycleCount}`);
      }
    }, 2000);
  }
}

function moveNextTrainToRepair(track) {
  // Ensure repair position is empty
  if (trainsInRepair.get(track)) {
    console.log(`Track ${track} repair position is occupied`);
    return;
  }
  
  const nextTrainId = nextTrainSlots.get(track);
  if (nextTrainId) {
    console.log(`Moving train ${nextTrainId} to repair position on track ${track}`);
    
    // Move to repair position
    trainsInRepair.set(track, nextTrainId);
    nextTrainSlots.set(track, null);
    
    const trainElement = document.querySelector(`.train[data-id="${nextTrainId}"]`);
    if (trainElement) {
      trainElement.style.transition = 'all 1.5s ease-out';
      trainElement.style.left = `${REPAIR_X}px`;
      trainElement.style.top = `${TRACK_Y[track]}px`;
    }
    
    // Fill next slot from queue
    if (trainQueue.length > 0) {
      const queuedTrain = trainQueue.shift();
      performTrainEntry(queuedTrain, track);
    }
  }
}

function performTrainEntry(trainId, track) {
  console.log(`Train ${trainId} entering track ${track} as next`);
  
  const train = localStatusData.find(t => t.train_id === trainId);
  if (!train) return;
  
  // Ensure next slot is empty
  if (nextTrainSlots.get(track)) {
    console.log(`Track ${track} next position is occupied`);
    trainQueue.unshift(trainId); // Put back in queue
    return;
  }
  
  // Assign to track's next slot
  trackAssignments.set(trainId, track);
  nextTrainSlots.set(track, trainId);
  
  const y = TRACK_Y[track];
  
  // Check if element exists
  let trainElement = document.querySelector(`.train[data-id="${trainId}"]`);
  
  if (!trainElement) {
    // Create new element
    trainElement = createTrainElement(train, track, true);
    document.getElementById('trains-layer').appendChild(trainElement);
  }
  
  // Animate to next position
  setTimeout(() => {
    trainElement.style.transition = 'all 1.5s ease-out';
    trainElement.style.left = `${NEXT_TRAIN_X}px`;
    trainElement.style.top = `${y}px`;
    trainElement.style.opacity = '1';
    
    showEntryNotification(trainId, track);
  }, 100);
}

// Sequential Track Healing System with Variable Delays
function startHealthImprovementSystem() {
  console.log('Variable delay healing system started');
  
  // Start healing cycles
  setInterval(() => {
    if (!healingCycleInProgress) {
      startHealingCycle();
    }
  }, HEALTH_UPDATE_MS);
  
  // Update countdown
  updateHealthCountdown();
  setInterval(updateHealthCountdown, 1000);
}

function startHealingCycle() {
  console.log('Starting healing cycle with variable delays');
  healingCycleInProgress = true;
  currentHealingTrack = 1;
  
  processTrackHealing();
}

function processTrackHealing() {
  if (currentHealingTrack > 4) {
    healingCycleInProgress = false;
    console.log('Healing cycle complete');
    return;
  }
  
  console.log(`Processing healing for track ${currentHealingTrack}`);
  
  const trainId = trainsInRepair.get(currentHealingTrack);
  
  if (trainId && !healingTrains.has(trainId)) {
    const train = localStatusData.find(t => t.train_id === trainId);
    
    if (train && train.fitness_status !== 'Healthy') {
      const healingDuration = HEALING_TIMES[train.fitness_status.toLowerCase()] || 10000;
      startTrainHealing(train, currentHealingTrack, healingDuration);
    }
  }
  
  const delay = TRACK_DELAYS[currentHealingTrack];
  console.log(`Waiting ${delay/1000}s before track ${currentHealingTrack + 1}`);
  
  setTimeout(() => {
    currentHealingTrack++;
    processTrackHealing();
  }, delay);
}

function startTrainHealing(train, track, duration) {
  const healingHours = Math.round((duration / 1000) * HOURS_PER_SECOND);
  console.log(`Starting ${healingHours} hours healing for ${train.fitness_status} train ${train.train_id} on track ${track}`);
  
  healingTrains.set(train.train_id, {
    startTime: Date.now(),
    duration: duration,
    track: track,
    initialStatus: train.fitness_status
  });
  
  showTrackHealingAnimation(track, train.train_id, train.fitness_status);
  
  const trainElement = document.querySelector(`.train[data-id="${train.train_id}"]`);
  if (trainElement) {
    trainElement.classList.add('healing');
    
    // Add healing progress bar
    const progressBar = document.createElement('div');
    progressBar.className = 'healing-progress';
    progressBar.innerHTML = `
      <div class="progress-bar">
        <div class="progress-fill" style="width: 0%"></div>
      </div>
      <div class="progress-time">${healingHours}h</div>
    `;
    trainElement.appendChild(progressBar);
  }
}

function updateHealingProgress(trainId, progress, remainingMs) {
  const trainElement = document.querySelector(`.train[data-id="${trainId}"]`);
  if (trainElement) {
    const progressFill = trainElement.querySelector('.progress-fill');
    if (progressFill) {
      progressFill.style.width = `${progress}%`;
    }
    
    // Convert remaining time to hours
    const remainingHours = Math.ceil((remainingMs / 1000) * HOURS_PER_SECOND);
    const progressTime = trainElement.querySelector('.progress-time');
    if (progressTime && remainingMs > 0) {
      progressTime.textContent = `${remainingHours}h`;
    }
  }
}

function completeHealing(trainId, track) {
  console.log(`Completed healing for train ${trainId}`);
  
  healingTrains.delete(trainId);
  
  const trainIndex = localStatusData.findIndex(t => t.train_id === trainId);
  if (trainIndex !== -1) {
    localStatusData[trainIndex] = {
      ...localStatusData[trainIndex],
      fitness_status: 'Healthy',
      days_until_next_service: 40,
      consequence_if_skipped: 'Regular maintenance',
      exitTimer: Date.now() + EXIT_DELAY_MS
    };
    
    trainDaysTracking.set(trainId, {
      lastUpdate: Date.now(),
      totalDays: 40,
      statusLastChanged: Date.now(),
      cycleCount: (trainDaysTracking.get(trainId)?.cycleCount || 0)
    });
    
    exitingTrains.add(trainId);
    
    updateAllVisualizations();
    
    const trainElement = document.querySelector(`.train[data-id="${trainId}"]`);
    if (trainElement) {
      trainElement.classList.remove('healing');
      trainElement.className = 'train healthy exiting';
      
      const progressBar = trainElement.querySelector('.healing-progress');
      if (progressBar) progressBar.remove();
      
      const exitBadge = document.createElement('div');
      exitBadge.className = 'exit-badge';
      exitBadge.innerHTML = `<i class="fas fa-check"></i> Ready`;
      trainElement.appendChild(exitBadge);
    }
  }
  
  showHealingCompleteNotification(trainId, track);
}

function showTrackHealingAnimation(track, trainId, status) {
  const trainElement = document.querySelector(`.train[data-id="${trainId}"]`);
  if (!trainElement) return;
  
  const rect = trainElement.getBoundingClientRect();
  const color = status === 'Critical' ? 'rgba(239, 68, 68, 0.3)' : 'rgba(245, 158, 11, 0.3)';
  
  const healEffect = document.createElement('div');
  healEffect.className = 'track-heal-effect';
  healEffect.style.cssText = `
    position: fixed;
    left: ${rect.left - 50}px;
    top: ${rect.top - 10}px;
    width: ${rect.width + 100}px;
    height: ${rect.height + 20}px;
    background: radial-gradient(ellipse at center, ${color}, transparent);
    border-radius: 50%;
    pointer-events: none;
    z-index: 50;
    animation: healWave 2s ease-out infinite;
  `;
  
  document.body.appendChild(healEffect);
  
  const healingInfo = healingTrains.get(trainId);
  if (healingInfo) {
    setTimeout(() => healEffect.remove(), healingInfo.duration);
  }
}

function showHealingCompleteNotification(trainId, track) {
  const notification = document.createElement('div');
  notification.className = 'healing-notification';
  notification.innerHTML = `
    <i class="fas fa-check-circle"></i>
    <span>Track ${track}: Train ${trainId} maintenance completed!</span>
    <div style="font-size: 0.8rem; margin-top: 4px; opacity: 0.8;">Exiting in 10 seconds...</div>
  `;
  notification.style.cssText = `
    position: fixed;
    top: ${80 + (track - 1) * 30}px;
    right: 20px;
    padding: 1rem 2rem;
    background: linear-gradient(135deg, rgba(16, 185, 129, 0.95), rgba(5, 150, 105, 0.95));
    color: white;
    border-radius: 12px;
    box-shadow: 0 10px 40px rgba(16, 185, 129, 0.4);
    z-index: 1000;
    animation: slideInRight 0.5s ease-out;
  `;
  
  document.body.appendChild(notification);
  
  setTimeout(() => {
    notification.style.animation = 'slideOutRight 0.3s ease-in';
    setTimeout(() => notification.remove(), 300);
  }, 3000);
}

function showExitNotification(trainId, track) {
  const notification = document.createElement('div');
  notification.innerHTML = `
    <i class="fas fa-sign-out-alt"></i>
    Train ${trainId} has left Track ${track}
  `;
  notification.style.cssText = `
    position: fixed;
    bottom: ${20 + (track - 1) * 60}px;
    right: 20px;
    padding: 0.75rem 1.5rem;
    background: linear-gradient(135deg, rgba(59, 130, 246, 0.9), rgba(37, 99, 235, 0.9));
    color: white;
    border-radius: 8px;
    animation: slideInRight 0.5s ease-out;
  `;
  
  document.body.appendChild(notification);
  
  setTimeout(() => {
    notification.style.animation = 'slideOutRight 0.3s ease-in';
    setTimeout(() => notification.remove(), 300);
  }, 3000);
}

function showEntryNotification(trainId, track) {
  const notification = document.createElement('div');
  notification.innerHTML = `
    <i class="fas fa-sign-in-alt"></i>
    Train ${trainId} ready on Track ${track}
  `;
  notification.style.cssText = `
    position: fixed;
    bottom: ${20 + (track - 1) * 60}px;
    left: 20px;
    padding: 0.75rem 1.5rem;
    background: linear-gradient(135deg, rgba(251, 146, 60, 0.9), rgba(249, 115, 22, 0.9));
    color: white;
    border-radius: 8px;
    animation: slideInLeft 0.5s ease-out;
  `;
  
  document.body.appendChild(notification);
  
  setTimeout(() => {
    notification.style.animation = 'slideOutLeft 0.3s ease-in';
    setTimeout(() => notification.remove(), 300);
  }, 3000);
}

function updateHealthCountdown() {
  const timeLeft = Math.ceil((HEALTH_UPDATE_MS - (Date.now() % HEALTH_UPDATE_MS)) / 1000);
  const hoursEquivalent = Math.round(timeLeft * HOURS_PER_SECOND);
  
  const countdownElements = document.querySelectorAll('.health-countdown');
  countdownElements.forEach(el => {
    if (healingCycleInProgress) {
      el.innerHTML = `<i class="fas fa-cog fa-spin"></i> Maintenance cycle in progress...`;
    } else {
      el.innerHTML = `Next cycle: ${timeLeft}s (${hoursEquivalent} hours)`;
    }
  });
}

function updateAllVisualizations() {
  updateSummaryCounts(localStatusData);
  renderStatusTable(localStatusData, currentRecData);
  
  const allRepairTrains = Array.from(trainsInRepair.values()).filter(id => id !== null);
  const activeRecs = currentRecData.filter(r => {
    const train = localStatusData.find(t => t.train_id === r.train_id);
    return train && 
           train.fitness_status !== 'Healthy' && 
           allRepairTrains.includes(train.train_id);
  });
  renderRecommendations(activeRecs);
  
  updateYardTrains();
}

async function fetchAll() {
  try {
    const [statusRes, recRes] = await Promise.all([
      fetch(`${API_BASE}/api/current_status`),
      fetch(`${API_BASE}/api/recommendation`)
    ]);
    
    if (!statusRes.ok || !recRes.ok) throw new Error("API fetch failed");
    
    const statusData = await statusRes.json();
    const recData = await recRes.json();
    
    return { statusData, recData };
  } catch (error) {
    console.error("Fetch error:", error);
    return { statusData: localStatusData, recData: currentRecData };
  }
}

function renderTracksSVG() {
  const svg = document.getElementById("tracks-svg");
  svg.innerHTML = "";
  svg.setAttribute("viewBox", "0 0 1000 500");
  
  // Create definitions
  const defs = document.createElementNS("http://www.w3.org/2000/svg", "defs");
  
  const trackGradient = document.createElementNS("http://www.w3.org/2000/svg", "linearGradient");
  trackGradient.setAttribute("id", "trackGradient");
  trackGradient.innerHTML = `
    <stop offset="0%" style="stop-color:#1e293b;stop-opacity:0.8" />
    <stop offset="50%" style="stop-color:#334155;stop-opacity:0.6" />
    <stop offset="100%" style="stop-color:#1e293b;stop-opacity:0.8" />
  `;
  defs.appendChild(trackGradient);
  
  svg.appendChild(defs);
  
  // Draw zones with proper positioning
  // Queue zone (left)
  const queueZone = document.createElementNS("http://www.w3.org/2000/svg", "rect");
  queueZone.setAttribute("x", 20);
  queueZone.setAttribute("y", 60);
  queueZone.setAttribute("width", 180);
  queueZone.setAttribute("height", 380);
  queueZone.setAttribute("fill", "rgba(251, 146, 60, 0.03)");
  queueZone.setAttribute("stroke", "rgba(251, 146, 60, 0.2)");
  queueZone.setAttribute("stroke-width", "2");
  queueZone.setAttribute("stroke-dasharray", "5 5");
  queueZone.setAttribute("rx", 10);
  svg.appendChild(queueZone);
  
  // Next zone
  const nextZone = document.createElementNS("http://www.w3.org/2000/svg", "rect");
  nextZone.setAttribute("x", 220);
  nextZone.setAttribute("y", 60);
  nextZone.setAttribute("width", 160);
  nextZone.setAttribute("height", 380);
  nextZone.setAttribute("fill", "rgba(251, 191, 36, 0.03)");
  nextZone.setAttribute("stroke", "rgba(251, 191, 36, 0.2)");
  nextZone.setAttribute("stroke-width", "2");
  nextZone.setAttribute("rx", 10);
  svg.appendChild(nextZone);
  
  // Repair zone
  const repairZone = document.createElementNS("http://www.w3.org/2000/svg", "rect");
  repairZone.setAttribute("x", 450);
  repairZone.setAttribute("y", 60);
  repairZone.setAttribute("width", 200);
  repairZone.setAttribute("height", 380);
  repairZone.setAttribute("fill", "rgba(0, 240, 255, 0.03)");
  repairZone.setAttribute("stroke", "rgba(0, 240, 255, 0.2)");
  repairZone.setAttribute("stroke-width", "2");
  repairZone.setAttribute("rx", 10);
  svg.appendChild(repairZone);
  
  // Exit zone
  const exitZone = document.createElementNS("http://www.w3.org/2000/svg", "rect");
  exitZone.setAttribute("x", 780);
  exitZone.setAttribute("y", 60);
  exitZone.setAttribute("width", 140);
  exitZone.setAttribute("height", 380);
  exitZone.setAttribute("fill", "rgba(16, 185, 129, 0.03)");
  exitZone.setAttribute("stroke", "rgba(16, 185, 129, 0.2)");
  exitZone.setAttribute("stroke-width", "2");
  exitZone.setAttribute("stroke-dasharray", "5 5");
  exitZone.setAttribute("rx", 10);
  svg.appendChild(exitZone);
  
  // Zone labels
  const labels = [
    { text: "QUEUE", x: 110, color: "rgba(251, 146, 60, 0.8)" },
    { text: "NEXT", x: 300, color: "rgba(251, 191, 36, 0.8)" },
    { text: "REPAIR BAY", x: 550, color: "rgba(0, 240, 255, 0.8)" },
    { text: "EXIT", x: 850, color: "rgba(16, 185, 129, 0.8)" }
  ];
  
  labels.forEach(label => {
    const text = document.createElementNS("http://www.w3.org/2000/svg", "text");
    text.setAttribute("x", label.x);
    text.setAttribute("y", 45);
    text.setAttribute("text-anchor", "middle");
    text.setAttribute("fill", label.color);
    text.setAttribute("font-size", "12");
    text.setAttribute("font-weight", "600");
    text.textContent = label.text;
    svg.appendChild(text);
  });
  
  // Draw tracks
  for (let t = 1; t <= 4; t++) {
    const y = TRACK_Y[t];
    
    // Track background
    const trackBg = document.createElementNS("http://www.w3.org/2000/svg", "rect");
    trackBg.setAttribute("x", 20);
    trackBg.setAttribute("y", y - 20);
    trackBg.setAttribute("width", 900);
    trackBg.setAttribute("height", 40);
    trackBg.setAttribute("fill", "url(#trackGradient)");
    trackBg.setAttribute("rx", 20);
    trackBg.setAttribute("opacity", "0.2");
    svg.appendChild(trackBg);
    
    // Rails
    const rail1 = document.createElementNS("http://www.w3.org/2000/svg", "line");
    rail1.setAttribute("x1", 30);
    rail1.setAttribute("y1", y - 8);
    rail1.setAttribute("x2", 910);
    rail1.setAttribute("y2", y - 8);
    rail1.setAttribute("stroke", "#475569");
    rail1.setAttribute("stroke-width", "2");
    rail1.setAttribute("opacity", "0.5");
    svg.appendChild(rail1);
    
    const rail2 = document.createElementNS("http://www.w3.org/2000/svg", "line");
    rail2.setAttribute("x1", 30);
    rail2.setAttribute("y1", y + 8);
    rail2.setAttribute("x2", 910);
    rail2.setAttribute("y2", y + 8);
    rail2.setAttribute("stroke", "#475569");
    rail2.setAttribute("stroke-width", "2");
    rail2.setAttribute("opacity", "0.5");
    svg.appendChild(rail2);
    
    // Track number with delay
    const trackNum = document.createElementNS("http://www.w3.org/2000/svg", "text");
    trackNum.setAttribute("x", 430);
    trackNum.setAttribute("y", y + 5);
    trackNum.setAttribute("text-anchor", "end");
    trackNum.setAttribute("fill", "rgba(148, 163, 184, 0.8)");
    trackNum.setAttribute("font-size", "12");
    trackNum.setAttribute("font-weight", "600");
    trackNum.textContent = `T${t} (${TRACK_DELAYS[t]/1000}s)`;
    svg.appendChild(trackNum);
    
    // Flow arrows
    for (let i = 0; i < 3; i++) {
      const arrow = document.createElementNS("http://www.w3.org/2000/svg", "text");
      arrow.setAttribute("x", 380 + i * 100);
      arrow.setAttribute("y", y + 5);
      arrow.setAttribute("fill", "rgba(0, 240, 255, 0.2)");
      arrow.setAttribute("font-size", "16");
      arrow.textContent = "→";
      arrow.style.animation = `flowArrow ${2 + t * 0.3}s ease-in-out infinite`;
      arrow.style.animationDelay = `${i * 0.4}s`;
      svg.appendChild(arrow);
    }
  }
}

function createTrainElement(train, track, isEntering = false) {
  const div = document.createElement("div");
  div.className = "train";
  const fitness = (train.fitness_status || "Healthy").toLowerCase();
  div.classList.add(fitness);
  div.dataset.id = train.train_id;
  div.dataset.track = track;
  
  const y = TRACK_Y[track] || 250;
  
  // Set initial position based on role
  if (isEntering) {
    div.style.left = `${QUEUE_X_END}px`;
    div.style.top = `${y}px`;
    div.style.opacity = '0.5';
  } else {
    // Position based on current assignment
    if (trainsInRepair.get(track) === train.train_id) {
      div.style.left = `${REPAIR_X}px`;
      div.style.top = `${y}px`;
    } else if (nextTrainSlots.get(track) === train.train_id) {
      div.style.left = `${NEXT_TRAIN_X}px`;
      div.style.top = `${y}px`;
    } else {
      // In queue
      const queueIndex = trainQueue.indexOf(train.train_id);
      if (queueIndex >= 0) {
        const col = queueIndex % 2;
        const row = Math.floor(queueIndex / 2);
        div.style.left = `${QUEUE_X_START + col * 60}px`;
        div.style.top = `${120 + row * 60}px`;
        div.style.opacity = '0.7';
      } else {
        div.style.left = `${QUEUE_X_START}px`;
        div.style.top = `${y}px`;
      }
    }
  }
  
  // Days indicator
  const daysLeft = train.days_until_next_service || 0;
  let daysColor = '#10b981';
  if (daysLeft <= 0) {
    daysColor = '#ef4444';
  } else if (daysLeft <= DAYS_TO_MINOR) {
    daysColor = '#f59e0b';
  }
  
  const cycleInfo = trainDaysTracking.get(train.train_id);
  const cycleCount = cycleInfo?.cycleCount || 0;
  
  div.innerHTML = `
    <div class="train-body">
      <div class="train-lights ${fitness}"></div>
      <div class="train-info">
        <div class="id">${train.train_id}</div>
        <div class="days-indicator" style="color: ${daysColor};">
          ${Math.round(daysLeft)}d
        </div>
      </div>
      ${track ? `<span class="track-badge">T${track}</span>` : ''}
      ${cycleCount > 0 ? `<span class="cycle-badge">C${cycleCount}</span>` : ''}
    </div>
  `;
  
  div.dataset.info = JSON.stringify(train);
  
  div.addEventListener('mouseenter', (e) => {
    createHoverParticles(e);
    div.style.zIndex = '10';
  });
  
  div.addEventListener('mouseleave', () => {
    div.style.zIndex = '1';
  });
  
  div.addEventListener('click', (e) => {
    e.stopPropagation();
    showDetailModal(train);
  });
  
  return div;
}

function updateYardTrains() {
  const layer = document.getElementById("trains-layer");
  
  localStatusData.forEach(train => {
    const existingTrain = layer.querySelector(`[data-id="${train.train_id}"]`);
    
    if (existingTrain) {
      const fitness = (train.fitness_status || "Healthy").toLowerCase();
      
      if (!healingTrains.has(train.train_id)) {
        existingTrain.className = `train ${fitness}`;
        if (exitingTrains.has(train.train_id)) {
          existingTrain.classList.add('exiting');
        }
      }
      
      existingTrain.dataset.info = JSON.stringify(train);
      
      const daysIndicator = existingTrain.querySelector('.days-indicator');
      if (daysIndicator) {
        const daysLeft = train.days_until_next_service || 0;
        let daysColor = '#10b981';
        if (daysLeft <= 0) {
          daysColor = '#ef4444';
        } else if (daysLeft <= DAYS_TO_MINOR) {
          daysColor = '#f59e0b';
        }
        daysIndicator.style.color = daysColor;
        daysIndicator.textContent = `${Math.round(daysLeft)}d`;
      }
      
      const lights = existingTrain.querySelector('.train-lights');
      if (lights && !healingTrains.has(train.train_id)) {
        lights.className = `train-lights ${fitness}`;
      }
    }
  });
}

function createHoverParticles(e) {
  const train = e.currentTarget;
  const rect = train.getBoundingClientRect();
  
  for (let i = 0; i < 6; i++) {
    const particle = document.createElement('div');
    particle.style.cssText = `
      position: fixed;
      width: 4px;
      height: 4px;
      background: linear-gradient(45deg, #00f0ff, #10b981);
      border-radius: 50%;
      left: ${rect.left + rect.width / 2}px;
      top: ${rect.bottom}px;
      pointer-events: none;
      z-index: 100;
    `;
    document.body.appendChild(particle);
    
    const angle = (Math.PI * 2 * i) / 6;
    const distance = 30 + Math.random() * 20;
    particle.animate([
      { transform: 'translate(0, 0) scale(1)', opacity: 1 },
      { transform: `translate(${Math.cos(angle) * distance}px, ${Math.sin(angle) * distance}px) scale(0)`, opacity: 0 }
    ], {
      duration: 800,
      easing: 'cubic-bezier(0.4, 0, 0.2, 1)'
    }).onfinish = () => particle.remove();
  }
}

// Rest of UI functions remain the same...
function animateStatCounter(element, newValue) {
  const current = parseInt(element.dataset.value) || 0;
  const duration = 1000;
  const start = Date.now();
  
  const animate = () => {
    const elapsed = Date.now() - start;
    const progress = Math.min(elapsed / duration, 1);
    const value = Math.floor(current + (newValue - current) * easeOutQuart(progress));
    
    element.textContent = value;
    
    if (progress < 1) {
      requestAnimationFrame(animate);
    } else {
      element.dataset.value = newValue;
    }
  };
  
  animate();
}

function easeOutQuart(t) {
  return 1 - Math.pow(1 - t, 4);
}

function updateSummaryCounts(statusData) {
  const total = statusData.length;
  const critical = statusData.filter(t => (t.fitness_status||"").toLowerCase() === "critical").length;
  const minor = statusData.filter(t => (t.fitness_status||"").toLowerCase() === "minor").length;
  const healthy = statusData.filter(t => (t.fitness_status||"").toLowerCase() === "healthy").length;
  
  animateStatCounter(document.querySelector('#stat-total .stat-value'), total);
  animateStatCounter(document.querySelector('#stat-critical .stat-value'), critical);
  animateStatCounter(document.querySelector('#stat-minor .stat-value'), minor);
  animateStatCounter(document.querySelector('#stat-healthy .stat-value'), healthy);
  
  updateHealthChart(critical, minor, healthy);
  updateChartCenterLabel(healthy, total);
}

function updateChartCenterLabel(healthy, total) {
  const percentage = total > 0 ? Math.round((healthy / total) * 100) : 0;
  document.querySelector('.chart-percentage').textContent = `${percentage}%`;
}

function updateHealthChart(critical, minor, healthy) {
  const ctx = document.getElementById("healthChart").getContext("2d");
  
  if (healthChart) {
    healthChart.data.datasets[0].data = [critical, minor, healthy];
    healthChart.update('active');
    return;
  }
  
  healthChart = new Chart(ctx, {
    type: 'doughnut',
    data: {
      labels: ['Critical', 'Minor Issues', 'Healthy'],
      datasets: [{
        data: [critical, minor, healthy],
        backgroundColor: [
          'rgba(239, 68, 68, 0.8)',
          'rgba(245, 158, 11, 0.8)',
          'rgba(16, 185, 129, 0.8)'
        ],
        borderColor: [
          'rgba(239, 68, 68, 1)',
          'rgba(245, 158, 11, 1)',
          'rgba(16, 185, 129, 1)'
        ],
        borderWidth: 2,
        hoverOffset: 4
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      cutout: '70%',
      plugins: {
        legend: {
          position: 'bottom',
          labels: {
            color: '#94a3b8',
            padding: 15,
            font: { size: 11 }
          }
        }
      },
      animation: {
        animateRotate: true,
        animateScale: true,
        duration: 1500,
        easing: 'easeInOutQuart'
      }
    }
  });
}

function renderStatusTable(statusData, recData) {
  const tbody = document.getElementById("status-body");
  tbody.innerHTML = "";
  
  statusData.forEach((train, idx) => {
    const match = recData.find(r => r.train_id === train.train_id) || {};
    const fitness = (train.fitness_status || "Healthy").toLowerCase();
    const track = trackAssignments.get(train.train_id);
    const isInRepair = Array.from(trainsInRepair.values()).includes(train.train_id);
    const isNext = Array.from(nextTrainSlots.values()).includes(train.train_id);
    const inQueue = trainQueue.includes(train.train_id);
    const isExiting = exitingTrains.has(train.train_id);
    const isHealing = healingTrains.has(train.train_id);
    const cycleInfo = trainDaysTracking.get(train.train_id);
    
    let locationBadge = '';
    if (isHealing) {
      const healingInfo = healingTrains.get(train.train_id);
      const elapsed = Date.now() - healingInfo.startTime;
      const remainingHours = Math.ceil(((healingInfo.duration - elapsed) / 1000) * HOURS_PER_SECOND);
      locationBadge = `<span class="location-badge healing">Repairing (${remainingHours}h left)</span>`;
    } else if (isExiting) {
      locationBadge = `<span class="location-badge exiting">Exiting T${track}</span>`;
    } else if (isInRepair) {
      locationBadge = `<span class="location-badge in-repair">Repair Bay T${track}</span>`;
    } else if (isNext) {
      locationBadge = `<span class="location-badge next">Next T${track}</span>`;
    } else if (inQueue) {
      const queuePos = trainQueue.indexOf(train.train_id) + 1;
      locationBadge = `<span class="location-badge in-queue">Queue #${queuePos}</span>`;
    } else if (reEntryQueue.includes(train.train_id)) {
      locationBadge = `<span class="location-badge re-entry">Awaiting Re-entry</span>`;
    }
    
    const daysLeft = train.days_until_next_service || 0;
    let daysColor = '';
    if (daysLeft <= 0) {
      daysColor = 'critical-days';
    } else if (daysLeft <= DAYS_TO_MINOR) {
      daysColor = 'warning-days';
    }
    
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>
        <div style="display: flex; align-items: center; gap: 8px;">
          <i class="fas fa-train" style="color: ${fitness === 'healthy' ? '#10b981' : fitness === 'critical' ? '#ef4444' : '#f59e0b'}; font-size: 12px;"></i>
          ${train.train_id}
          ${locationBadge}
          ${cycleInfo?.cycleCount > 0 ? `<span class="cycle-indicator">Cycle ${cycleInfo.cycleCount}</span>` : ''}
        </div>
      </td>
      <td>${train.yard_position || '—'}</td>
      <td class="${fitness}">
        <span style="display: inline-flex; align-items: center; gap: 6px;">
          <span class="status-dot ${fitness}"></span>
          ${train.fitness_status || 'Healthy'}
        </span>
      </td>
      <td>${train.next_service_due_date || '—'}</td>
      <td>
        <span class="days-badge ${daysColor}">
          <i class="fas fa-clock" style="font-size: 10px; margin-right: 4px;"></i>
          ${Math.round(daysLeft)} days
        </span>
      </td>
      <td>${match.consequence_if_skipped || train.consequence_if_skipped || '—'}</td>
    `;
    
    tbody.appendChild(tr);
    tr.style.animation = `tableRowSlide 0.3s ease-out ${idx * 0.02}s both`;
  });
  
  updateLastUpdateTime();
}

function renderRecommendations(activeRecs) {
  const container = document.getElementById("recommend-list");
  container.innerHTML = "";
  
  // Track status card
  const statusCard = document.createElement('div');
  statusCard.className = 'healing-status-card';
  statusCard.innerHTML = `
    <div style="font-weight: 600; margin-bottom: 12px; color: var(--accent-cyan);">
      <i class="fas fa-tools"></i> Track Status
    </div>
  `;
  
  for (let t = 1; t <= 4; t++) {
    const repairTrain = trainsInRepair.get(t);
    const nextTrain = nextTrainSlots.get(t);
    const healingInfo = repairTrain ? healingTrains.get(repairTrain) : null;
    
    const trackDiv = document.createElement('div');
    trackDiv.className = 'track-status-row';
    
    let repairStatus = 'Empty';
    let repairClass = 'empty';
    
    if (healingInfo) {
      const elapsed = Date.now() - healingInfo.startTime;
      const progress = Math.round((elapsed / healingInfo.duration) * 100);
      const remainingHours = Math.ceil(((healingInfo.duration - elapsed) / 1000) * HOURS_PER_SECOND);
      repairStatus = `
        <div style="display: flex; align-items: center; gap: 8px;">
          <span>${repairTrain}</span>
          <div class="healing-bar">
            <div class="healing-fill" style="width: ${progress}%"></div>
          </div>
          <span style="font-size: 0.7rem;">${remainingHours}h</span>
        </div>
      `;
      repairClass = 'healing';
    } else if (repairTrain) {
      const train = localStatusData.find(t => t.train_id === repairTrain);
      repairStatus = `${repairTrain} (${train?.fitness_status || 'Ready'})`;
      repairClass = train?.fitness_status?.toLowerCase() || 'ready';
    }
    
    trackDiv.innerHTML = `
      <div class="track-label">T${t}</div>
      <div class="track-positions">
        <div class="position-box ${repairClass}">
          <span class="position-label">Repair:</span>
          <span>${repairStatus}</span>
        </div>
        <div class="position-box next">
          <span class="position-label">Next:</span>
          <span>${nextTrain || 'Empty'}</span>
        </div>
      </div>
    `;
    statusCard.appendChild(trackDiv);
  }
  
  statusCard.innerHTML += `
    <div style="margin-top: 12px; padding-top: 12px; border-top: 1px solid var(--border-color);">
      <div style="display: flex; justify-content: space-between; font-size: 0.875rem;">
        <span>Queue</span>
        <span style="color: var(--warning);">${trainQueue.length}</span>
      </div>
      <div style="display: flex; justify-content: space-between; font-size: 0.875rem; margin-top: 4px;">
        <span>Re-entry</span>
        <span style="color: var(--danger);">${reEntryQueue.length}</span>
      </div>
    </div>
    <div class="health-countdown" style="margin-top: 8px; text-align: center; font-size: 0.8rem; color: var(--accent-cyan);"></div>
  `;
  
  container.appendChild(statusCard);
}

function showDetailModal(obj) {
  const modal = document.getElementById("detail-modal");
  const content = document.getElementById("modal-content");
  const title = document.getElementById("modal-title");
  
  const fitness = (obj.fitness_status || "Healthy").toLowerCase();
  const statusColor = fitness === "critical" ? "#ef4444" : 
                      fitness === "minor" ? "#f59e0b" : "#10b981";
  const track = trackAssignments.get(obj.train_id);
  const daysLeft = obj.days_until_next_service || 0;
  const hoursLeft = Math.round(daysLeft * SECONDS_PER_DAY * HOURS_PER_SECOND);
  const cycleInfo = trainDaysTracking.get(obj.train_id);
  
  title.innerHTML = `
    <i class="fas fa-train" style="margin-right: 8px;"></i>
    Train ${obj.train_id} ${track ? `(Track ${track})` : ''}
  `;
  
  content.innerHTML = `
    <div style="display: grid; gap: 1rem;">
      <div style="display: flex; align-items: center; gap: 1rem; padding: 1rem; background: rgba(0, 240, 255, 0.05); border-radius: 8px;">
        <div style="width: 60px; height: 60px; display: flex; align-items: center; justify-content: center; background: ${statusColor}20; border-radius: 50%;">
          <i class="fas fa-${fitness === 'critical' ? 'exclamation-triangle' : fitness === 'minor' ? 'exclamation-circle' : 'check-circle'}" style="font-size: 1.5rem; color: ${statusColor};"></i>
        </div>
        <div>
          <div style="font-size: 0.875rem; color: var(--text-secondary);">Current Status</div>
          <div style="font-size: 1.25rem; font-weight: 600; color: ${statusColor}; text-transform: capitalize;">${obj.fitness_status || 'Healthy'}</div>
          <div style="font-size: 0.875rem; color: var(--text-secondary); margin-top: 4px;">
            <i class="fas fa-clock"></i> ${Math.round(daysLeft)} days (${hoursLeft} hours)
          </div>
          ${cycleInfo ? `<div style="font-size: 0.875rem; color: var(--text-secondary);">
            <i class="fas fa-sync"></i> Maintenance cycles completed: ${cycleInfo.cycleCount}
          </div>` : ''}
        </div>
      </div>
      
      <table style="width: 100%; border-collapse: collapse;">
        ${Object.entries(obj).filter(([key]) => !['recentlyHealed', 'exitTimer'].includes(key))
          .map(([key, value]) => {
          const formattedKey = key.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase());
          return `
            <tr style="border-bottom: 1px solid var(--border-color);">
              <td style="padding: 0.75rem; font-weight: 600; color: var(--text-secondary); width: 40%;">
                ${formattedKey}
              </td>
              <td style="padding: 0.75rem; color: var(--text-primary);">
                ${value ?? '—'}
              </td>
            </tr>
          `;
        }).join('')}
      </table>
      
      <div style="display: flex; justify-content: flex-end; gap: 0.75rem; margin-top: 1rem;">
        <button onclick="closeModal()" style="padding: 0.75rem 1.5rem; background: transparent; border: 1px solid var(--border-color); color: var(--text-primary); border-radius: 8px; cursor: pointer;">
          Close
        </button>
      </div>
    </div>
  `;
  
  modal.classList.remove("hidden");
}

function closeModal() {
  document.getElementById("detail-modal").classList.add("hidden");
}

function updateLastUpdateTime() {
  const now = new Date();
  const timeStr = now.toLocaleTimeString('en-US', { 
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  });
  document.getElementById('last-update-time').textContent = timeStr;
}

// Enhanced styles
const enhancedStyles = document.createElement('style');
enhancedStyles.textContent = `
  #yard {
    height: 500px !important;
    position: relative;
    overflow: hidden !important;
  }
  
  #tracks-svg, #trains-layer {
    position: absolute;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
  }
  
  .train {
    min-width: 80px;
    max-width: 100px;
    padding: 6px;
    position: absolute;
    transform: translate(-50%, -50%);
    transition: left 1.5s ease-out, top 1.5s ease-out, opacity 1s ease-out;
    cursor: pointer;
    z-index: 1;
  }
  
  .train.healing {
    animation: healingPulse 2s ease-in-out infinite;
    z-index: 5;
  }
  
  @keyframes healingPulse {
    0%, 100% { 
      box-shadow: 0 0 20px rgba(0, 240, 255, 0.4);
      transform: translate(-50%, -50%) scale(1);
    }
    50% { 
      box-shadow: 0 0 40px rgba(0, 240, 255, 0.8);
      transform: translate(-50%, -50%) scale(1.05);
    }
  }
  
  .train.exiting {
    animation: exitPulse 1s ease-in-out infinite;
  }
  
  @keyframes exitPulse {
    0%, 100% { box-shadow: 0 0 20px rgba(16, 185, 129, 0.5); }
    50% { box-shadow: 0 0 40px rgba(16, 185, 129, 0.8); }
  }
  
  .train-body {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 2px;
    position: relative;
  }
  
  .train-lights {
    width: 10px;
    height: 10px;
    border-radius: 50%;
    animation: lightPulse 1s ease-in-out infinite;
  }
  
  .train-lights.critical {
    background: #ef4444;
    box-shadow: 0 0 15px #ef4444;
  }
  
  .train-lights.minor {
    background: #f59e0b;
    box-shadow: 0 0 12px #f59e0b;
  }
  
  .train-lights.healthy {
    background: #10b981;
    box-shadow: 0 0 8px #10b981;
  }
  
  @keyframes lightPulse {
    0%, 100% { opacity: 1; transform: scale(1); }
    50% { opacity: 0.7; transform: scale(0.9); }
  }
  
  .days-indicator {
    font-size: 10px;
    font-weight: 700;
    padding: 1px 3px;
    border-radius: 3px;
    background: rgba(0, 0, 0, 0.3);
  }
  
  .track-badge {
    position: absolute;
    top: -6px;
    right: -6px;
    background: linear-gradient(135deg, #3b82f6, #2563eb);
    color: white;
    padding: 1px 4px;
    border-radius: 4px;
    font-size: 0.55rem;
    font-weight: 700;
  }
  
  .cycle-badge {
    position: absolute;
    top: -6px;
    left: -6px;
    background: linear-gradient(135deg, #8b5cf6, #7c3aed);
    color: white;
    padding: 1px 4px;
    border-radius: 4px;
    font-size: 0.55rem;
    font-weight: 700;
  }
  
  .healing-progress {
    position: absolute;
    bottom: -20px;
    left: 50%;
    transform: translateX(-50%);
    width: 70px;
    background: rgba(0, 0, 0, 0.8);
    padding: 3px;
    border-radius: 4px;
    z-index: 10;
  }
  
  .progress-bar {
    height: 3px;
    background: rgba(255, 255, 255, 0.2);
    border-radius: 2px;
    overflow: hidden;
  }
  
  .progress-fill {
    height: 100%;
    background: linear-gradient(90deg, #00f0ff, #10b981);
    transition: width 0.5s ease;
  }
  
  .progress-time {
    text-align: center;
    font-size: 0.6rem;
    color: #00f0ff;
    margin-top: 1px;
  }
  
  .exit-badge {
    position: absolute;
    bottom: -8px;
    background: linear-gradient(135deg, #10b981, #059669);
    color: white;
    padding: 1px 6px;
    border-radius: 8px;
    font-size: 0.6rem;
    font-weight: 700;
    animation: exitBadgePulse 1s ease-in-out infinite;
  }
  
  @keyframes exitBadgePulse {
    0%, 100% { transform: scale(1); }
    50% { transform: scale(1.1); }
  }
  
  .location-badge {
    padding: 2px 6px;
    border-radius: 8px;
    font-size: 0.65rem;
    font-weight: 600;
    margin-left: 4px;
  }
  
  .location-badge.healing {
    background: linear-gradient(135deg, rgba(0, 240, 255, 0.3), rgba(0, 240, 255, 0.1));
    color: #00f0ff;
    animation: blink 0.5s ease-in-out infinite;
  }
  
  .location-badge.in-repair {
    background: rgba(59, 130, 246, 0.2);
    color: #3b82f6;
  }
  
  .location-badge.next {
    background: rgba(251, 191, 36, 0.2);
    color: #fbbf24;
  }
  
  .location-badge.in-queue {
    background: rgba(251, 146, 60, 0.2);
    color: #fb923c;
  }
  
  .location-badge.re-entry {
    background: rgba(139, 92, 246, 0.2);
    color: #a78bfa;
  }
  
  .location-badge.exiting {
    background: rgba(16, 185, 129, 0.2);
    color: #10b981;
    animation: blink 0.5s ease-in-out infinite;
  }
  
  .cycle-indicator {
    font-size: 0.6rem;
    padding: 1px 4px;
    background: rgba(139, 92, 246, 0.2);
    color: #a78bfa;
    border-radius: 6px;
    margin-left: 4px;
  }
  
  .days-badge {
    display: inline-flex;
    align-items: center;
    padding: 2px 6px;
    background: rgba(148, 163, 184, 0.1);
    border-radius: 10px;
    font-size: 0.75rem;
    font-weight: 600;
  }
  
  .days-badge.warning-days {
    background: rgba(245, 158, 11, 0.2);
    color: #fbbf24;
  }
  
  .days-badge.critical-days {
    background: rgba(239, 68, 68, 0.2);
    color: #fca5a5;
    animation: urgentPulse 1s ease-in-out infinite;
  }
  
  @keyframes urgentPulse {
    0%, 100% { box-shadow: 0 0 0 0 rgba(239, 68, 68, 0); }
    50% { box-shadow: 0 0 8px 2px rgba(239, 68, 68, 0.3); }
  }
  
  .healing-status-card {
    background: linear-gradient(135deg, rgba(59, 130, 246, 0.1), rgba(37, 99, 235, 0.05));
    border: 1px solid rgba(59, 130, 246, 0.3);
    border-radius: 12px;
    padding: 12px;
    margin-bottom: 12px;
  }
  
  .track-status-row {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 6px 0;
    border-bottom: 1px solid rgba(148, 163, 184, 0.1);
  }
  
  .track-label {
    font-weight: 600;
    color: var(--accent-cyan);
    min-width: 40px;
    font-size: 0.8rem;
  }
  
  .track-positions {
    display: flex;
    gap: 8px;
    flex: 1;
  }
  
  .position-box {
    flex: 1;
    font-size: 0.7rem;
    padding: 3px 6px;
    border-radius: 6px;
    background: rgba(148, 163, 184, 0.1);
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  
  .position-label {
    font-size: 0.6rem;
    opacity: 0.7;
  }
  
  .position-box.critical {
    background: rgba(239, 68, 68, 0.15);
    color: #ef4444;
  }
  
  .position-box.minor {
    background: rgba(245, 158, 11, 0.15);
    color: #f59e0b;
  }
  
  .position-box.healing {
    background: rgba(0, 240, 255, 0.1);
    color: #00f0ff;
  }
  
  .position-box.next {
    background: rgba(251, 191, 36, 0.1);
    color: #fbbf24;
  }
  
  .healing-bar {
    width: 60px;
    height: 4px;
    background: rgba(255, 255, 255, 0.1);
    border-radius: 2px;
    overflow: hidden;
    display: inline-block;
  }
  
  .healing-fill {
    height: 100%;
    background: linear-gradient(90deg, #00f0ff, #10b981);
    transition: width 0.5s ease;
  }
  
  @keyframes statusChange {
    0% { transform: translate(-50%, -50%) scale(1.2); }
    100% { transform: translate(-50%, -50%) scale(1); }
  }
  
  @keyframes healWave {
    0% { 
      transform: scale(0.8);
      opacity: 0;
    }
    50% { 
      transform: scale(1.2);
      opacity: 1;
    }
    100% { 
      transform: scale(1.4);
      opacity: 0;
    }
  }
  
  @keyframes flowArrow {
    0%, 100% { opacity: 0.2; transform: translateX(0); }
    50% { opacity: 0.6; transform: translateX(10px); }
  }
  
  @keyframes slideInLeft {
    from { transform: translateX(-100%); opacity: 0; }
    to { transform: translateX(0); opacity: 1; }
  }
  
  @keyframes slideOutLeft {
    from { transform: translateX(0); opacity: 1; }
    to { transform: translateX(-100%); opacity: 0; }
  }
  
  @keyframes slideInRight {
    from { transform: translateX(100%); opacity: 0; }
    to { transform: translateX(0); opacity: 1; }
  }
  
  @keyframes slideOutRight {
    from { transform: translateX(0); opacity: 1; }
    to { transform: translateX(100%); opacity: 0; }
  }
  
  @keyframes blink {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.6; }
  }
`;
document.head.appendChild(enhancedStyles);

// Main refresh function
async function refreshAll() {
  try {
    const { statusData, recData } = await fetchAll();
    
    if (isInitialLoad) {
      backendStatusData = [...statusData];
      localStatusData = [...statusData];
      currentRecData = recData;
      isInitialLoad = false;
      
      initializeDepotPositions();
    } else {
      backendStatusData = [...statusData];
      localStatusData = statusData.map(backendTrain => {
        const localTrain = localStatusData.find(t => t.train_id === backendTrain.train_id);
        if (localTrain && (healingTrains.has(backendTrain.train_id) || exitingTrains.has(backendTrain.train_id))) {
          return {
            ...backendTrain,
            fitness_status: localTrain.fitness_status,
            days_until_next_service: localTrain.days_until_next_service,
            consequence_if_skipped: localTrain.consequence_if_skipped,
            exitTimer: localTrain.exitTimer
          };
        }
        return backendTrain;
      });
      currentRecData = recData;
    }
    
    updateAllVisualizations();
    
    // Render yard
    renderTracksSVG();
    const layer = document.getElementById("trains-layer");
    
    if (layer.children.length === 0 || isInitialLoad) {
      layer.innerHTML = "";
      
      // Create all visible trains
      localStatusData.forEach(train => {
        const track = trackAssignments.get(train.train_id) || 0;
        if (track || trainQueue.includes(train.train_id)) {
          const el = createTrainElement(train, track, false);
          if (el) layer.appendChild(el);
        }
      });
    } else {
      updateYardTrains();
    }
    
  } catch (err) {
    console.error("Error refreshing:", err);
  }
}