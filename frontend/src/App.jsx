import React, { useState, useEffect, useCallback, useMemo } from 'react';
import Sidebar from './components/Sidebar';
import DisasterTopBar from './components/DisasterTopBar';
import DisasterAlertsNav from './components/DisasterAlertsNav';
import EmergencySOSCenter from './components/EmergencySOSCenter';
import ShelterResourceManager from './components/ShelterResourceManager';
import OfflineMeshNetwork from './components/OfflineMeshNetwork';
import FamilySafetyCenter from './components/FamilySafetyCenter';
import LiveRescueDashboard from './components/LiveRescueDashboard';
import Dashboard from './components/Dashboard';
import MLAnomalyCenter from './components/MLAnomalyCenter';
import SMSAlertCenter from './components/SMSAlertCenter';
import IncidentCommand from './components/IncidentCommand';
import DataUploader from './components/DataUploader';
import About from './components/About';
import FloatChatBot from './components/FloatChatBot';
import AuthScreen from './components/AuthScreen';
import AdminPortal from './components/AdminPortal';
import { clearSession } from './utils/authClient';
import { tabsForRole } from './utils/roles';
import { MessageSquare } from 'lucide-react';
import './App.css';

// Initial Fallback Data for Shelters & Scenarios
const DEFAULT_SCENARIO = {
  id: 'SCENARIO-TSUNAMI-01',
  type: 'TSUNAMI',
  name: 'Bay of Bengal Subduction Tsunami Warning',
  severity: 'CRITICAL',
  agency: 'Indian National Centre for Ocean Information Services (INCOIS) / PTWC',
  timestamp: new Date().toISOString(),
  epicenter: { lat: 12.85, lng: 88.42, depthKm: 18, magnitude: 8.4 },
  affectedRadiusKm: 320,
  waveVelocityKph: 740,
  estimatedWaveHeightMeters: 4.8,
  coastalEtaMinutes: 28,
  affectedSectors: ['Sector A - Coastal Fishery Zone', 'Sector B - Marina Port Harbour', 'Sector C - Lowland Delta'],
  elevationHazardLimitMeters: 25,
  instructions: 'Evacuate immediately to designated high-elevation safe citadels (+30m elevation) or inland beyond 3 kilometers. Do not approach shorelines to observe receding water.'
};

const DEFAULT_SHELTERS = [
  {
    id: 'SHELTER-01',
    name: 'St. Jude High-Elevation Safe Citadel',
    address: '44 Summit Ridge Road, North Sector',
    lat: 13.085,
    lng: 80.195,
    elevationMeters: 44,
    totalCapacity: 850,
    currentOccupancy: 540,
    structureRating: 'Tsunami & Earthquake Grade 9 Citadel',
    contactPhone: '+1-800-555-0101',
    distanceKm: 2.3,
    status: 'OPEN',
    facilities: {
      medicalClinic: true,
      potableWater: true,
      solarMicrogrid: true,
      dieselBackup: true,
      babyCare: true,
      wheelchairAccess: true,
      petFriendly: true,
      starlinkMeshUplink: true
    },
    supplies: {
      waterLiters: 8500,
      foodMeals: 3400,
      medicalKits: 140,
      blankets: 650
    }
  },
  {
    id: 'SHELTER-02',
    name: 'Naval Station Fort Coastal Bunker',
    address: 'Pier 12, Naval Defense Perimeter',
    lat: 13.065,
    lng: 80.225,
    elevationMeters: 28,
    totalCapacity: 1400,
    currentOccupancy: 1260,
    structureRating: 'Cat-5 Supercyclone Bunker & Helipad',
    contactPhone: '+1-800-555-0102',
    distanceKm: 1.4,
    status: 'NEAR_CAPACITY',
    facilities: {
      medicalClinic: true,
      potableWater: true,
      solarMicrogrid: true,
      dieselBackup: true,
      babyCare: false,
      wheelchairAccess: true,
      petFriendly: false,
      starlinkMeshUplink: true
    },
    supplies: {
      waterLiters: 1950,
      foodMeals: 1100,
      medicalKits: 28,
      blankets: 320
    }
  },
  {
    id: 'SHELTER-03',
    name: 'Hilltop Community Center & Polytech',
    address: '88 Highland Avenue, West Ward',
    lat: 13.098,
    lng: 80.175,
    elevationMeters: 58,
    totalCapacity: 650,
    currentOccupancy: 310,
    structureRating: 'Flood-Immune Reinforced Concrete Complex',
    contactPhone: '+1-800-555-0103',
    distanceKm: 3.8,
    status: 'OPEN',
    facilities: {
      medicalClinic: true,
      potableWater: true,
      solarMicrogrid: true,
      dieselBackup: true,
      babyCare: true,
      wheelchairAccess: true,
      petFriendly: true,
      starlinkMeshUplink: true
    },
    supplies: {
      waterLiters: 7800,
      foodMeals: 4200,
      medicalKits: 95,
      blankets: 700
    }
  },
  {
    id: 'SHELTER-04',
    name: 'Govt Model Higher Secondary Safe Haven',
    address: '12 Central Boulevard, Sector 4',
    lat: 13.045,
    lng: 80.210,
    elevationMeters: 34,
    totalCapacity: 900,
    currentOccupancy: 710,
    structureRating: 'State Engineered Emergency Evac Facility',
    contactPhone: '+1-800-555-0104',
    distanceKm: 2.9,
    status: 'OPEN',
    facilities: {
      medicalClinic: true,
      potableWater: true,
      solarMicrogrid: false,
      dieselBackup: true,
      babyCare: true,
      wheelchairAccess: true,
      petFriendly: false,
      starlinkMeshUplink: false
    },
    supplies: {
      waterLiters: 4100,
      foodMeals: 2200,
      medicalKits: 62,
      blankets: 480
    }
  }
];

const DEFAULT_WAREHOUSES = [
  {
    id: 'WH-CENTRAL-01',
    name: 'Central Disaster Logistics Depot (Ridge North)',
    lat: 13.120,
    lng: 80.160,
    elevationMeters: 62,
    accessibleByRoad: true,
    inventory: {
      waterLiters: 65000,
      foodMeals: 28000,
      medicalKits: 650,
      antibioticsUnits: 1200,
      blankets: 4800,
      waterPurificationTabs: 50000,
      satelliteRadios: 120
    },
    availableTransport: [
      { id: 'TRK-01', type: 'Heavy Amphibious 6x6 Cargo Truck', capacityKg: 8000, status: 'AVAILABLE' },
      { id: 'TRK-02', type: 'All-Terrain High-Clearance 4x4', capacityKg: 4000, status: 'AVAILABLE' }
    ]
  },
  {
    id: 'WH-PORT-02',
    name: 'Port Sector Staging Warehouse Beta',
    lat: 13.055,
    lng: 80.245,
    elevationMeters: 16,
    accessibleByRoad: false,
    inventory: {
      waterLiters: 14000,
      foodMeals: 6200,
      medicalKits: 140,
      antibioticsUnits: 300,
      blankets: 1100,
      waterPurificationTabs: 12000,
      satelliteRadios: 25
    },
    availableTransport: [
      { id: 'BOAT-01', type: 'Twin-Hull Flood Rescue Cargo Vessel', capacityKg: 3500, status: 'AVAILABLE' }
    ]
  },
  {
    id: 'WH-WEST-03',
    name: 'West Ward Airfield Strategic Hub',
    lat: 13.078,
    lng: 80.140,
    elevationMeters: 52,
    accessibleByRoad: true,
    inventory: {
      waterLiters: 42000,
      foodMeals: 19500,
      medicalKits: 420,
      antibioticsUnits: 850,
      blankets: 3200,
      waterPurificationTabs: 35000,
      satelliteRadios: 90
    },
    availableTransport: [
      { id: 'TRK-03', type: 'All-Terrain Tactical Transporter', capacityKg: 6000, status: 'AVAILABLE' }
    ]
  }
];

const DEFAULT_SOS_LIST = [
  {
    id: 'SOS-2026-9011',
    timestamp: new Date(Date.now() - 12 * 60000).toISOString(),
    userName: 'Priya Sharma & Family',
    phone: '+91-98765-43210',
    lat: 13.042,
    lng: 80.231,
    elevationMeters: 6,
    emergencyType: 'RISING_WATER_FLOOD',
    peopleCount: { adults: 2, children: 2, elderly: 1, disabled: 0 },
    medicalNotes: 'Elderly diabetic with insulin requirement. Water at 1.4m and rising.',
    triageScore: 'CRITICAL_P1',
    status: 'IN_TRANSIT',
    assignedUnit: {
      id: 'SAR-BOAT-03',
      name: 'NDRF Swift-Water Rescue Vessel Alpha',
      callsign: 'RESCUE-EAGLE-3',
      responderCount: 4,
      lat: 13.048,
      lng: 80.226,
      distanceKm: 0.8,
      etaMinutes: 4
    },
    networkOrigin: 'BLE_MESH_RELAY',
    hopCount: 3,
    acknowledgedByGateway: true
  },
  {
    id: 'SOS-2026-9012',
    timestamp: new Date(Date.now() - 25 * 60000).toISOString(),
    userName: 'Karthik Raman',
    phone: '+91-98401-23456',
    lat: 13.071,
    lng: 80.218,
    elevationMeters: 14,
    emergencyType: 'STRUCTURAL_COLLAPSE_TRAPPED',
    peopleCount: { adults: 3, children: 0, elderly: 0, disabled: 1 },
    medicalNotes: 'Leg fracture trapped under collapsed roof beam.',
    triageScore: 'CRITICAL_P1',
    status: 'DISPATCHED',
    assignedUnit: {
      id: 'SAR-MEDIC-01',
      name: 'Urban Search & Extrication Squad Delta',
      callsign: 'LIFE-SAVER-1',
      responderCount: 6,
      lat: 13.082,
      lng: 80.205,
      distanceKm: 1.8,
      etaMinutes: 9
    },
    networkOrigin: 'CELLULAR_ONLINE',
    hopCount: 0,
    acknowledgedByGateway: true
  },
  {
    id: 'SOS-2026-9013',
    timestamp: new Date(Date.now() - 4 * 60000).toISOString(),
    userName: 'Ananya & Ramesh',
    phone: '+91-97110-88223',
    lat: 13.059,
    lng: 80.238,
    elevationMeters: 8,
    emergencyType: 'LOST_STRANDED_NO_POWER',
    peopleCount: { adults: 2, children: 1, elderly: 0, disabled: 0 },
    medicalNotes: 'Cell tower down, phone battery 12%. Need route to safe shelter.',
    triageScore: 'HIGH_P2',
    status: 'QUEUED',
    assignedUnit: null,
    networkOrigin: 'WIFI_DIRECT_MESH',
    hopCount: 2,
    acknowledgedByGateway: true
  }
];

function App() {
  const [activeTab, setActiveTab] = useState('disaster-alerts');
  const [telemetryData, setTelemetryData] = useState([]);
  const [selectedBuoy, setSelectedBuoy] = useState('ALL');
  const [isChatOpen, setIsChatOpen] = useState(false);
  const [apiKey, setApiKey] = useState('');
  const [isResetting, setIsResetting] = useState(false);
  const [isMongoConnected, setIsMongoConnected] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [telemetryError, setTelemetryError] = useState(null);

  // Disaster Management Core States
  const [disasterScenario, setDisasterScenario] = useState(DEFAULT_SCENARIO);
  const [allScenarios, setAllScenarios] = useState([
    { key: 'tsunami', name: 'Bay of Bengal Subduction Tsunami Warning', type: 'TSUNAMI', severity: 'CRITICAL' },
    { key: 'cyclone', name: 'Category-4 Supercyclone Vardah II', type: 'CYCLONE', severity: 'CRITICAL' },
    { key: 'flood', name: 'Monsoonal Cloudburst & River Breach', type: 'FLOOD', severity: 'HIGH' },
    { key: 'earthquake', name: 'Coastal Subduction 7.6M Seismological Rupture', type: 'EARTHQUAKE', severity: 'CRITICAL' },
    { key: 'normal', name: 'All Clear - Routine Oceanographic Monitoring', type: 'NORMAL', severity: 'LOW' }
  ]);
  const [shelters, setShelters] = useState(DEFAULT_SHELTERS);
  const [warehouses, setWarehouses] = useState(DEFAULT_WAREHOUSES);
  const [activeSOSList, setActiveSOSList] = useState(DEFAULT_SOS_LIST);
  const [isOfflineMode, setIsOfflineMode] = useState(false);
  const [userLocation, setUserLocation] = useState({ lat: 13.052, lng: 80.235, name: 'Marina Coastal Strip (+4m)' });
  const [session, setSession] = useState(null);
  const [authReady, setAuthReady] = useState(false);

  // Fetch Telemetry Data
  const fetchTelemetry = useCallback(async () => {
    try {
      const response = await fetch('/api/telemetry');
      if (response.ok) {
        const data = await response.json();
        setTelemetryData(data);
        setTelemetryError(null);
      }
    } catch (err) {
      console.warn('Telemetry server offline. Using disaster resilience fallback.');
      setTelemetryError('FloatChat Telemetry Backend is currently in standby.');
    }
  }, []);

  // Fetch Disaster Scenario & Shelters from API
  const fetchDisasterData = useCallback(async () => {
    try {
      const [scenRes, shRes, whRes, sosRes] = await Promise.all([
        fetch('/api/disaster/scenario'),
        fetch('/api/disaster/shelters'),
        fetch('/api/disaster/warehouses'),
        fetch('/api/disaster/sos')
      ]);

      if (scenRes.ok) {
        const scenData = await scenRes.json();
        if (scenData.activeScenario) setDisasterScenario(scenData.activeScenario);
        if (scenData.allScenarios) setAllScenarios(scenData.allScenarios);
      }
      if (shRes.ok) {
        const shData = await shRes.json();
        if (shData && shData.length > 0) setShelters(shData);
      }
      if (whRes.ok) {
        const whData = await whRes.json();
        if (whData && whData.length > 0) setWarehouses(whData);
      }
      if (sosRes.ok) {
        const sosData = await sosRes.json();
        if (sosData && sosData.length > 0) setActiveSOSList(sosData);
      }
    } catch (err) {
      console.warn('Disaster API offline, running in decentralized local/mesh mode.');
    }
  }, []);

  // Fetch Server & Database Status
  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch('/api/status');
      if (res.ok) {
        const data = await res.json();
        setIsMongoConnected(data.isMongoConnected);
      }
    } catch (err) {
      setIsMongoConnected(false);
    }
  }, []);

  useEffect(() => {
    fetchTelemetry();
    fetchDisasterData();
    fetchStatus();
    
    const interval = setInterval(() => {
      fetchDisasterData();
      fetchStatus();
    }, 10000);
    return () => clearInterval(interval);
  }, [fetchTelemetry, fetchDisasterData, fetchStatus]);

  useEffect(() => {
    let cancelled = false;
    const raw = localStorage.getItem('floatchat_session');
    if (!raw) {
      setAuthReady(true);
      return undefined;
    }
    let saved;
    try {
      saved = JSON.parse(raw);
    } catch {
      clearSession();
      setAuthReady(true);
      return undefined;
    }
    fetch('/api/auth/me', { headers: { Authorization: `Bearer ${saved.token}` } })
      .then(async (response) => {
        if (!response.ok) throw new Error('expired');
        return response.json();
      })
      .then((data) => {
        if (!cancelled) setSession({ token: saved.token, user: data.user });
      })
      .catch(() => {
        clearSession();
        if (!cancelled) setSession(null);
      })
      .finally(() => {
        if (!cancelled) setAuthReady(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const role = session?.user?.role || 'user';
  const allowedTabs = useMemo(() => tabsForRole(role), [role]);

  useEffect(() => {
    if (!session) return;
    if (!allowedTabs.includes(activeTab)) setActiveTab('disaster-alerts');
  }, [session, activeTab, allowedTabs]);

  const handleLogout = () => {
    clearSession();
    setSession(null);
    setActiveTab('disaster-alerts');
  };

  // Switch Disaster Scenario Handler
  const handleSwitchScenario = async (key) => {
    try {
      const res = await fetch('/api/disaster/scenario', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key })
      });
      if (res.ok) {
        const data = await res.json();
        setDisasterScenario(data.scenario);
      } else {
        // local fallback
        const found = allScenarios.find(s => s.key === key);
        if (found) {
          setDisasterScenario({
            name: found.name,
            severity: found.severity,
            type: found.type,
            agency: 'FloatChat Local Sentinel',
            instructions: 'Evacuate immediately to high ground and safe shelters.'
          });
        }
      }
    } catch (err) {
      console.warn('Local scenario switch:', err);
    }
  };

  // Create Emergency SOS Handler
  const handleCreateSOS = async (sosPayload) => {
    try {
      const res = await fetch('/api/disaster/sos', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(sosPayload)
      });
      if (res.ok) {
        const data = await res.json();
        setActiveSOSList(prev => [data.sos, ...prev]);
        return data.sos;
      }
    } catch (err) {
      console.warn('Saving SOS to local mesh queue');
    }

    // Local mesh fallback
    const localSOS = {
      id: `SOS-2026-${Math.floor(1000 + Math.random() * 9000)}`,
      timestamp: new Date().toISOString(),
      userName: sosPayload.userName || 'Citizen Survivor',
      phone: sosPayload.phone,
      lat: sosPayload.lat,
      lng: sosPayload.lng,
      elevationMeters: sosPayload.elevationMeters || 6,
      emergencyType: sosPayload.emergencyType,
      peopleCount: sosPayload.peopleCount,
      medicalNotes: sosPayload.medicalNotes,
      triageScore: 'CRITICAL_P1',
      status: 'QUEUED',
      assignedUnit: {
        name: 'NDRF Swift-Water Rescue Vessel Alpha',
        callsign: 'RESCUE-EAGLE-3',
        distanceKm: 1.2,
        etaMinutes: 6
      },
      networkOrigin: isOfflineMode ? 'OFFLINE_BLE_MESH' : 'CELLULAR_ONLINE',
      hopCount: isOfflineMode ? 1 : 0
    };

    setActiveSOSList(prev => [localSOS, ...prev]);
    return localSOS;
  };

  // Update SOS Status Handler
  const handleUpdateSOSStatus = async (id, status, assignedUnit) => {
    try {
      await fetch(`/api/disaster/sos/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status, assignedUnit })
      });
    } catch (e) {
      // offline fallback
    }

    setActiveSOSList(prev =>
      prev.map(s => (s.id === id ? { ...s, status, assignedUnit: assignedUnit || s.assignedUnit } : s))
    );
  };

  // Navigate to Shelter from Shelter Directory
  const handleNavigateToShelter = (shelter) => {
    setActiveTab('disaster-alerts');
  };

  // Family Check-in from Shelter Directory
  const handleFamilyCheckIn = (shelter) => {
    setActiveTab('family-safety');
  };

  // Reset database handler
  const handleResetDb = async () => {
    setIsResetting(true);
    try {
      const response = await fetch('/api/reset', { method: 'POST' });
      if (response.ok) {
        await fetchTelemetry();
        await fetchDisasterData();
      }
    } catch (err) {
      console.error(err);
    } finally {
      setIsResetting(false);
    }
  };

  // Compute buoy alert count for badge indicator
  const alertCount = useMemo(() => {
    let count = 0;
    const recentReadings = {};
    telemetryData.forEach(d => {
      if (!recentReadings[d.buoyId] || new Date(d.timestamp) > new Date(recentReadings[d.buoyId].timestamp)) {
        recentReadings[d.buoyId] = d;
      }
    });

    Object.values(recentReadings).forEach(d => {
      if (d.oxygenContent < 4.0) count++;
      if (d.temperature > 24.0 && d.depth > 50) count++;
      if (d.batteryLevel < 25) count++;
      if (d.ph < 7.8 || d.ph > 8.5) count++;
    });

    return count;
  }, [telemetryData]);

  // Active pending SOS count
  const activeSOSCount = useMemo(() => {
    return (activeSOSList || []).filter(s => s.status !== 'RESCUED').length;
  }, [activeSOSList]);

  if (!authReady) {
    return (
      <div style={{
        minHeight: '100vh',
        display: 'grid',
        placeItems: 'center',
        background: 'var(--bg-page)',
        color: 'var(--text-secondary)',
        fontSize: '14px',
        gap: '12px',
        flexDirection: 'column'
      }}>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '12px' }}>
          <div style={{
            width: '40px', height: '40px',
            background: 'var(--color-primary)',
            borderRadius: '10px',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: '22px'
          }}>🌊</div>
          <span>Loading FloatChat AI…</span>
        </div>
      </div>
    );
  }

  if (!session) {
    return <AuthScreen onAuthenticated={setSession} />;
  }

  return (
    <div className="app-container">
      
      {/* Sidebar navigation and configurations */}
      <Sidebar 
        activeTab={activeTab} 
        setActiveTab={setActiveTab} 
        onResetDb={handleResetDb}
        isResetting={isResetting}
        apiKey={apiKey}
        setApiKey={setApiKey}
        isMongoConnected={isMongoConnected}
        alertCount={alertCount}
        activeSOSCount={activeSOSCount}
        allowedTabs={allowedTabs}
        currentUser={session.user}
        onLogout={handleLogout}
      />

      {/* Main Content Area */}
      <main className="main-content" style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
        
        {/* Disaster Management Header & Quick SOS Beacon: Visible ONLY on relevant disaster-management workflows */}
        {['disaster-alerts', 'emergency-sos', 'shelter-resources', 'family-safety', 'rescue-command', 'offline-mesh', 'incidents'].includes(activeTab) && (
          <DisasterTopBar 
            disasterScenario={disasterScenario}
            allScenarios={allScenarios}
            onSwitchScenario={handleSwitchScenario}
            isOfflineMode={isOfflineMode}
            onToggleOfflineMode={() => setIsOfflineMode(!isOfflineMode)}
            onOpenSOS={() => setActiveTab('emergency-sos')}
            activeTab={activeTab}
            setActiveTab={setActiveTab}
          />
        )}

        {/* Dynamic Disaster & Telemetry Views */}
        <div style={{ flex: 1 }}>
          
          {/* Feature 1: AI Disaster Alerts & Safe-Zone Navigation */}
          {activeTab === 'disaster-alerts' && (
            <DisasterAlertsNav 
              disasterScenario={disasterScenario}
              allScenarios={allScenarios}
              onSwitchScenario={handleSwitchScenario}
              shelters={shelters}
              onSelectShelterForSOS={(shelter) => {
                setActiveTab('emergency-sos');
              }}
            />
          )}

          {/* Feature 2: Emergency SOS & Rescue Tracking */}
          {activeTab === 'emergency-sos' && (
            <EmergencySOSCenter 
              activeSOSList={activeSOSList}
              onCreateSOS={handleCreateSOS}
              onUpdateSOSStatus={handleUpdateSOSStatus}
              isOfflineMode={isOfflineMode}
              selectedShelter={shelters[0]}
            />
          )}

          {/* Feature 3: Smart Shelter & Resource Management AI */}
          {activeTab === 'shelter-resources' && (
            <ShelterResourceManager 
              shelters={shelters}
              warehouses={warehouses}
              onNavigateToShelter={handleNavigateToShelter}
              onFamilyCheckIn={handleFamilyCheckIn}
              allowDispatch={role !== 'user'}
            />
          )}

          {/* Feature 4: Offline Mesh Networking & Store-and-Forward */}
          {activeTab === 'offline-mesh' && (
            <OfflineMeshNetwork 
              isOfflineMode={isOfflineMode}
              onToggleOfflineMode={() => setIsOfflineMode(!isOfflineMode)}
              userLocation={userLocation}
              activeSOSList={activeSOSList}
            />
          )}

          {/* Extra Feature: Family Safety Check-In Center */}
          {activeTab === 'family-safety' && (
            <FamilySafetyCenter 
              shelters={shelters}
              userLocation={userLocation}
              isOfflineMode={isOfflineMode}
            />
          )}

          {/* Extra Feature: Live Rescue Operations & Dispatch Console */}
          {activeTab === 'rescue-command' && (
            <LiveRescueDashboard 
              disasterScenario={disasterScenario}
              activeSOSList={activeSOSList}
              shelters={shelters}
              onUpdateSOSStatus={handleUpdateSOSStatus}
            />
          )}

          {/* Ocean Telemetry Views */}
          {activeTab === 'dashboard' && (
            <Dashboard 
              telemetryData={telemetryData} 
              selectedBuoy={selectedBuoy} 
              setSelectedBuoy={setSelectedBuoy}
            />
          )}

          {activeTab === 'ml-anomaly' && (
            <MLAnomalyCenter 
              telemetryData={telemetryData}
            />
          )}

          {activeTab === 'sms-alerts' && (
            <SMSAlertCenter />
          )}

          {activeTab === 'incidents' && (
            <IncidentCommand 
              telemetryData={telemetryData}
              onRefreshTelemetry={fetchTelemetry}
            />
          )}
          
          {activeTab === 'upload' && (
            <DataUploader 
              onUploadSuccess={fetchTelemetry}
              isMongoConnected={isMongoConnected}
            />
          )}
          
          {activeTab === 'admin-portal' && role === 'admin' && (
            <AdminPortal />
          )}

          {activeTab === 'about' && (
            <About />
          )}

        </div>
      </main>

      {/* FloatChat AI Floating Launcher */}
      <button 
        className="chat-launcher" 
        onClick={() => setIsChatOpen(!isChatOpen)}
        title="Open AI Disaster Rescue Coordinator"
      >
        <MessageSquare size={24} />
      </button>

      {/* FloatChat AI Chatbot Drawer */}
      <FloatChatBot 
        isOpen={isChatOpen} 
        onClose={() => setIsChatOpen(false)} 
        apiKey={apiKey}
        activeBuoy={selectedBuoy}
      />

    </div>
  );
}

export default App;
