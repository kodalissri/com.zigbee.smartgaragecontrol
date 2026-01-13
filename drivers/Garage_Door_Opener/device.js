'use strict';

const { Cluster } = require('zigbee-clusters');
const TuyaSpecificCluster = require('../../lib/TuyaSpecificCluster');
const TuyaSpecificClusterDevice = require('../../lib/TuyaSpecificClusterDevice');

Cluster.addCluster(TuyaSpecificCluster);

const dataPoints = {
    doorTrigger: 1,
    countdown: 2,
    garageDoorContact: 3,
    runtime: 4,
    openAlarmTime: 5,
    status: 12,
};

class GarageDoorTrigger extends TuyaSpecificClusterDevice {

    // --- Data Parsing ---
    convertMultiByte(chunks) {
        let value = 0;
        for (let i = 0; i < chunks.length; i++) {
            value = value << 8;
            value += chunks[i];
        }
        return value;
    }

    getDataValue(dpValue) {
        switch (dpValue.datatype) {
            case 0: return dpValue.data;
            case 1: return dpValue.data[0] === 1;
            case 2: return this.convertMultiByte(dpValue.data);
            case 4: return dpValue.data[0];
            default: return dpValue.data;
        }
    }

    // --- Core Logic: Trigger the Door ---
    async triggerDoorPulse() {
        this.homey.clearTimeout(this.delayedTriggerTimer);
        this.homey.clearTimeout(this.safetyTimer);

        const settings = this.getSettings();
        const countdownSeconds = parseInt(settings['count_down']) || 0;

        const sendPulse = async () => {
            this.log('Sending Pulse to Tuya MCU...');

            if (this.hasCapability('garage_Door_State_Capability')) {
                await this.setCapabilityValue('garage_Door_State_Capability', 'moving').catch(this.error);
            }

            const isCurrentlyOpen = this.getCapabilityValue('alarm_contact') === true;
            const expectedEndState = !isCurrentlyOpen;

            // Physical Zigbee Write
            await this.writeBool(dataPoints.doorTrigger, true).catch(this.error);

            // Start safety timer
            this.startSafetyTimer(expectedEndState);
        };

        if (countdownSeconds <= 0) {
            await sendPulse();
        } else {
            this.log(`Countdown active: waiting ${countdownSeconds}s`);
            if (this.hasCapability('garage_Door_State_Capability')) {
                await this.setCapabilityValue('garage_Door_State_Capability', '2').catch(this.error);
            }
            this.delayedTriggerTimer = this.homey.setTimeout(sendPulse, countdownSeconds * 1000);
        }
    }

    startSafetyTimer(expectedState) {
        this.homey.clearTimeout(this.safetyTimer);
        const runTimeSetting = parseInt(this.getSettings()['run_time']) || 20;

        this.safetyTimer = this.homey.setTimeout(async () => {
            // Get the most recent known contact state
            const currentContact = this.getCapabilityValue('alarm_contact');

            if (currentContact !== expectedState) {
                this.log(`Safety Alert: Movement failed. Door is actually ${currentContact ? 'Open' : 'Closed'}`);

                // 1. FORCE the UI button to match the physical sensor state
                // This clears the "moving" or "wrong" state from the button
                await this.setCapabilityValue('garage_Door_Button', currentContact).catch(this.error);

                // 2. Set the status text to Alarm
                if (this.hasCapability('garage_Door_State_Capability')) {
                    await this.setCapabilityValue('garage_Door_State_Capability', '1').catch(this.error);
                }

                // 3. Trigger Flow
                const rtTrigger = this.homey.flow.getDeviceTriggerCard('runtime_alarm_triggered');
                if (rtTrigger) rtTrigger.trigger(this).catch(this.error);
            }
        }, runTimeSetting * 1000);
    }

    // --- Initialization ---
    async onNodeInit({ zclNode }) {
        // 1. UI Button Listener
        if (this.hasCapability('garage_Door_Button')) {
            this.registerCapabilityListener('garage_Door_Button', async (value) => {
                this.log('UI Button Pressed');
                await this.triggerDoorPulse();
                return true;
            });
        }

        // 2. Flow Action Listener
        try {
            const pushActionCard = this.homey.flow.getActionCard('push_door_button');
            pushActionCard.registerRunListener(async (args, state) => {
                // Ensure we only trigger for the selected device
                if (args.device.getData().id !== this.getData().id) return;

                this.log('Flow Action Triggered');
                await this.triggerDoorPulse();
                return true;
            });
        } catch (err) {
            this.error('Flow Registration Error:', err.message);
        }

        // 3. Zigbee Events
        zclNode.endpoints[1].clusters.tuya.on("response", value => this.handleDataPoint(value));
    }

    async handleDataPoint(data) {
        const dp = data.dp;
        const value = this.getDataValue(data);
        this.log(`DP ${dp} reported:`, value);

        switch (dp) {
            case dataPoints.garageDoorContact:
                const isOpen = !!value;
                this.homey.clearTimeout(this.safetyTimer);
                this.homey.clearTimeout(this.delayedTriggerTimer);

                await this.setCapabilityValue('alarm_contact', isOpen).catch(this.error);
                if (this.hasCapability('garage_Door_Button')) {
                    // Sync UI button state with contact sensor
                    await this.setCapabilityValue('garage_Door_Button', isOpen).catch(this.error);
                }
                if (this.hasCapability('garage_Door_State_Capability')) {
                    await this.setCapabilityValue('garage_Door_State_Capability', isOpen ? 'open' : 'closed').catch(this.error);
                }
                break;

            case dataPoints.status:
                if (this.hasCapability('garage_Door_State_Capability')) {
                    await this.setCapabilityValue('garage_Door_State_Capability', value.toString()).catch(this.error);
                }
                break;
        }
    }

    async onSettings({ newSettings, changedKeys }) {
        const settingsMap = {
            'count_down': dataPoints.countdown,
            'run_time': dataPoints.runtime,
            'open_alarm_time': dataPoints.openAlarmTime
        };
        for (const key of changedKeys) {
            if (settingsMap[key]) {
                await this.writeData32(settingsMap[key], newSettings[key]).catch(this.error);
            }
        }
        return true;
    }
}

module.exports = GarageDoorTrigger;