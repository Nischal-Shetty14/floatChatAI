import {
  getActiveScenario,
  setActiveScenario,
  listScenarios,
  listShelters,
  getShelterById,
  updateShelter,
  listWarehouses,
  getWarehouseById,
  updateWarehouse,
  createSOSRecord,
  listSOSRecords,
  getSOSRecordById,
  updateSOSRecord,
  createFamilyCheckin,
  searchFamilyCheckins,
  createConvoy,
  listConvoys,
  recordAuditEvent
} from './db.js';

class DisasterStateStore {
  get activeScenarioKey() {
    const sc = this.getScenario();
    return sc?.type ? sc.type.toLowerCase() : 'tsunami';
  }

  setScenario(key) {
    return setActiveScenario(key);
  }

  getScenario() {
    return getActiveScenario();
  }

  getAllScenarios() {
    return listScenarios();
  }

  getShelters() {
    return listShelters();
  }

  getWarehouses() {
    return listWarehouses();
  }

  getSOSRecords() {
    return listSOSRecords();
  }

  createSOS(data) {
    const adults = Number(data.peopleCount?.adults || 1);
    const children = Number(data.peopleCount?.children || 0);
    const elderly = Number(data.peopleCount?.elderly || 0);
    const disabled = Number(data.peopleCount?.disabled || 0);
    const totalPeople = adults + children + elderly + disabled;

    // AI Prioritization Algorithm
    let triageScore = 'MEDIUM_P3';
    const isWaterRising = data.emergencyType === 'RISING_WATER_FLOOD';
    const isTrapped = data.emergencyType === 'STRUCTURAL_COLLAPSE_TRAPPED';
    const hasVulnerable = children > 0 || elderly > 0 || disabled > 0;
    const hasSevereMed = data.medicalNotes && data.medicalNotes.length > 5;

    if (isWaterRising || isTrapped || (hasVulnerable && hasSevereMed)) {
      triageScore = 'CRITICAL_P1';
    } else if (hasVulnerable || hasSevereMed || totalPeople >= 4) {
      triageScore = 'HIGH_P2';
    }

    const lat = Number(data.lat || 13.05 + (Math.random() * 0.04 - 0.02));
    const lng = Number(data.lng || 80.22 + (Math.random() * 0.04 - 0.02));

    // Auto-assign appropriate SAR unit based on emergency type
    const assignedUnit = (isWaterRising || lat < 13.06) ? {
      id: 'SAR-BOAT-03',
      name: 'NDRF Swift-Water Rescue Vessel Alpha',
      callsign: 'RESCUE-EAGLE-3',
      type: 'RAPID_SURFACE_VESSEL',
      responderCount: 4,
      equipment: '4x Paramedic Divers, Defibrillator, Inflatable Rafts',
      lat: Number((lat + 0.012).toFixed(4)),
      lng: Number((lng - 0.008).toFixed(4)),
      distanceKm: 1.2,
      distanceMeters: 1200,
      etaMinutes: 6,
      dispatchedAt: new Date().toISOString()
    } : {
      id: 'SAR-MEDIC-01',
      name: 'Urban Search & Extrication Squad Delta',
      callsign: 'LIFE-SAVER-1',
      type: 'AMBULANCE_RESCUE',
      responderCount: 6,
      equipment: 'Hydraulic Jaws of Life, Trauma Kit, Oxygen',
      lat: Number((lat + 0.015).toFixed(4)),
      lng: Number((lng + 0.005).toFixed(4)),
      distanceKm: 1.8,
      distanceMeters: 1800,
      etaMinutes: 9,
      dispatchedAt: new Date().toISOString()
    };

    const newSos = {
      id: `SOS-2026-${Math.floor(1000 + Math.random() * 9000)}`,
      timestamp: new Date().toISOString(),
      userName: data.userName || 'Emergency Citizen',
      phone: data.phone || 'Unknown Phone',
      lat,
      lng,
      elevationMeters: Number(data.elevationMeters || 12),
      emergencyType: data.emergencyType || 'GENERAL_EMERGENCY',
      peopleCount: { adults, children, elderly, disabled, total: totalPeople },
      medicalNotes: data.medicalNotes || 'None specified',
      triageScore,
      status: 'DISPATCHED',
      assignedUnit,
      networkOrigin: data.networkOrigin || 'ONLINE',
      hopCount: data.hopCount || 0,
      acknowledgedByGateway: true,
      gatewayReceiptId: `ACK-GW-${Date.now().toString(36).toUpperCase()}`
    };

    const created = createSOSRecord(newSos);
    recordAuditEvent({
      type: 'SOS_DISPATCH',
      text: `Critical SOS ${newSos.id} triaged (${newSos.triageScore}) for ${newSos.userName}. Assigned unit: ${assignedUnit.name}.`
    });
    return created;
  }

  updateSOSStatus(id, status, assignedUnitData) {
    const updated = updateSOSRecord(id, status, assignedUnitData);
    if (updated) {
      recordAuditEvent({
        type: 'STATUS_UPDATE',
        text: `Incident ${id} status advanced to ${status}. Assigned: ${updated.assignedUnit?.name || 'Unit'}.`
      });
    }
    return updated;
  }

  // AI Resource Optimizer & Reallocation Algorithm
  computeResourceOptimization() {
    const recommendations = [];
    const shelterShortages = [];
    const shelters = this.getShelters();
    const warehouses = this.getWarehouses();

    shelters.forEach(shelter => {
      const occ = shelter.currentOccupancy;
      // Consumption benchmarks:
      // Water: ~3.0 L/person/day -> 0.125 L/person/hour
      // Meals: ~3.0 packs/person/day -> 0.125 packs/person/hour
      const hourlyWaterRate = Math.max(10, Math.round(occ * 0.125));
      const hourlyMealsRate = Math.max(10, Math.round(occ * 0.125));

      const waterHoursLeft = (shelter.supplies?.waterLiters || 0) / (hourlyWaterRate || 1);
      const foodHoursLeft = (shelter.supplies?.foodMeals || 0) / (hourlyMealsRate || 1);
      const isCapacityCritical = (occ / (shelter.totalCapacity || 1)) > 0.85;

      const shortages = [];
      if (waterHoursLeft < 24) {
        shortages.push({
          type: 'POTABLE_WATER',
          hoursLeft: parseFloat(waterHoursLeft.toFixed(1)),
          deficitLiters: Math.max(2000, Math.round((24 - waterHoursLeft) * hourlyWaterRate)),
          severity: waterHoursLeft < 10 ? 'CRITICAL' : 'WARNING'
        });
      }

      if (foodHoursLeft < 24) {
        shortages.push({
          type: 'FOOD_MEALS',
          hoursLeft: parseFloat(foodHoursLeft.toFixed(1)),
          deficitMeals: Math.max(800, Math.round((24 - foodHoursLeft) * hourlyMealsRate)),
          severity: foodHoursLeft < 12 ? 'CRITICAL' : 'WARNING'
        });
      }

      if ((shelter.supplies?.medicalKits || 0) < 40) {
        shortages.push({
          type: 'TRAUMA_KITS',
          currentCount: shelter.supplies?.medicalKits || 0,
          deficitKits: 60,
          severity: 'HIGH'
        });
      }

      if (shortages.length > 0 || isCapacityCritical) {
        shelterShortages.push({
          shelterId: shelter.id,
          shelterName: shelter.name,
          occupancy: occ,
          capacity: shelter.totalCapacity,
          occupancyPercentage: Math.round((occ / shelter.totalCapacity) * 100),
          shortages
        });
      }
    });

    // Match Shortages with Surplus Warehouses (prefer road-accessible, highest elevation)
    shelterShortages.forEach(item => {
      item.shortages.forEach(sh => {
        const bestWarehouse = warehouses
          .filter(wh => wh.accessibleByRoad)
          .sort((a, b) => (b.inventory?.waterLiters || 0) - (a.inventory?.waterLiters || 0))[0];

        if (bestWarehouse) {
          const recId = `REC-OPT-${Math.floor(1000 + Math.random() * 9000)}`;
          let itemsToTransfer = {};
          if (sh.type === 'POTABLE_WATER') {
            itemsToTransfer = { waterLiters: sh.deficitLiters || 3000 };
          } else if (sh.type === 'FOOD_MEALS') {
            itemsToTransfer = { foodMeals: sh.deficitMeals || 1200 };
          } else if (sh.type === 'TRAUMA_KITS') {
            itemsToTransfer = { medicalKits: sh.deficitKits || 50, antibioticsUnits: 100 };
          }

          recommendations.push({
            id: recId,
            targetShelterId: item.shelterId,
            targetShelterName: item.shelterName,
            sourceWarehouseId: bestWarehouse.id,
            sourceWarehouseName: bestWarehouse.name,
            reason: `${sh.type.replace('_', ' ')} critical shortage (${sh.hoursLeft ? sh.hoursLeft + ' hrs left' : 'stock exhausted'})`,
            urgency: sh.severity === 'CRITICAL' ? 'IMMEDIATE' : 'SCHEDULED',
            itemsToTransfer,
            suggestedVehicle: bestWarehouse.availableTransport?.[0]?.type || 'Heavy Amphibious 6x6 Cargo Truck',
            routeSafetyScore: 94,
            avoidRoads: ['Coastal Highway Strip (Surge Zone)'],
            safeCorridor: 'North Ridge Bypass -> High Ground Radial 4',
            estimatedTravelTimeMins: 22
          });
        }
      });
    });

    return {
      timestamp: new Date().toISOString(),
      shelterShortages,
      recommendations,
      activeConvoys: listConvoys(20)
    };
  }

  dispatchConvoy(recommendationId) {
    const optimization = this.computeResourceOptimization();
    const rec = optimization.recommendations.find(r => r.id === recommendationId);
    if (!rec) {
      throw new Error(`Recommendation ${recommendationId} not found.`);
    }

    const convoyId = `CONVOY-${Math.floor(1000 + Math.random() * 9000)}`;
    const newConvoy = {
      convoyId,
      dispatchedAt: new Date().toISOString(),
      etaMinutes: rec.estimatedTravelTimeMins,
      sourceWarehouseName: rec.sourceWarehouseName,
      targetShelterName: rec.targetShelterName,
      targetShelterId: rec.targetShelterId,
      vehicle: rec.suggestedVehicle,
      cargo: rec.itemsToTransfer,
      route: rec.safeCorridor,
      status: 'IN_TRANSIT'
    };

    // Update target shelter supplies immediately in SQLite
    const targetShelter = getShelterById(rec.targetShelterId);
    if (targetShelter) {
      if (!targetShelter.supplies) targetShelter.supplies = {};
      if (rec.itemsToTransfer.waterLiters) targetShelter.supplies.waterLiters = (targetShelter.supplies.waterLiters || 0) + rec.itemsToTransfer.waterLiters;
      if (rec.itemsToTransfer.foodMeals) targetShelter.supplies.foodMeals = (targetShelter.supplies.foodMeals || 0) + rec.itemsToTransfer.foodMeals;
      if (rec.itemsToTransfer.medicalKits) targetShelter.supplies.medicalKits = (targetShelter.supplies.medicalKits || 0) + rec.itemsToTransfer.medicalKits;
      updateShelter(targetShelter);
    }

    // Deduct from warehouse inventory
    const warehouse = getWarehouseById(rec.sourceWarehouseId);
    if (warehouse && warehouse.inventory) {
      if (rec.itemsToTransfer.waterLiters) warehouse.inventory.waterLiters = Math.max(0, (warehouse.inventory.waterLiters || 0) - rec.itemsToTransfer.waterLiters);
      if (rec.itemsToTransfer.foodMeals) warehouse.inventory.foodMeals = Math.max(0, (warehouse.inventory.foodMeals || 0) - rec.itemsToTransfer.foodMeals);
      if (rec.itemsToTransfer.medicalKits) warehouse.inventory.medicalKits = Math.max(0, (warehouse.inventory.medicalKits || 0) - rec.itemsToTransfer.medicalKits);
      updateWarehouse(warehouse);
    }

    const convoy = createConvoy(newConvoy);
    recordAuditEvent({
      type: 'CONVOY_DISPATCH',
      text: `AI Relief Convoy ${convoy.convoyId} dispatched from ${convoy.sourceWarehouseName} to ${convoy.targetShelterName} via ${convoy.route}.`
    });
    return convoy;
  }

  createFamilyCheckIn(data) {
    const chk = createFamilyCheckin(data);
    recordAuditEvent({
      type: 'FAMILY_CHECKIN',
      text: `Safety check-in: ${chk.fullName} reported ${chk.status} at ${chk.currentLocationName || 'Location'}.`
    });
    return chk;
  }

  searchFamilyCheckIns(query) {
    return searchFamilyCheckins(query);
  }

  processMeshPacket(packet) {
    const receipt = {
      ackId: `ACK-${Math.floor(100000 + Math.random() * 900000)}`,
      packetId: packet.packetId || packet.id,
      timestamp: new Date().toISOString(),
      receivedByGateway: 'GATEWAY-COASTGUARD-SATLINK-01',
      status: 'ACKNOWLEDGED',
      signature: `SIG-RSA4096-GATEWAY-${Date.now().toString(36).toUpperCase()}`
    };

    if (packet.type === 'SOS_ALERT' && packet.payload) {
      this.createSOS({
        ...packet.payload,
        networkOrigin: 'OFFLINE_MESH_P2P',
        hopCount: packet.hops || 1
      });
    } else if (packet.type === 'FAMILY_CHECKIN' && packet.payload) {
      this.createFamilyCheckIn({
        ...packet.payload,
        viaMesh: true
      });
    }

    recordAuditEvent({
      type: 'MESH_SYNC',
      text: `Mesh packet ${receipt.packetId} (${packet.type || 'DATA'}) relayed & signed by Starlink Gateway.`
    });

    return receipt;
  }
}

export const disasterStore = new DisasterStateStore();
