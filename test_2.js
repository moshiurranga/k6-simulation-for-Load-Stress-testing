import http from 'k6/http';
import { check, sleep } from 'k6';
import { Rate, Trend, Counter } from 'k6/metrics';

const BASE_URL = 'https://stage-merchant.carrybee.com';

// ============================================
// 3 REAL USERS WITH THEIR CSRF TOKENS
// ============================================
const USERS = [
    {
        id: 1,
        name: 'Merchant One',
        email: 'merchant1@carrybee.com',
        csrfToken: '723d55c0fcb1c40f89d92437056497222be570b0892e7df4b0517bcf89543d27',
        role: 'admin',
        avgParcelsPerDay: 500
    },
    {
        id: 2,
        name: 'Merchant Two', 
        email: 'merchant2@carrybee.com',
        csrfToken: 'ddfbd0a7b30bde51bb2f2e3edbc6e56d9ee5979a9756aef072e1c148e4ecbb1b',
        role: 'manager',
        avgParcelsPerDay: 250
    },
    {
        id: 3,
        name: 'Merchant Three',
        email: 'merchant3@carrybee.com', 
        csrfToken: '2766a9cc3ce078fd9b4c0a8f5a75f4eaeae37c8e352fc2d0b080c3e49b892346',
        role: 'user',
        avgParcelsPerDay: 100
    }
];

// ============================================
// CUSTOM METRICS (Enterprise Monitoring)
// ============================================
const errorRate = new Rate('error_rate');
const dashboardTrend = new Trend('dashboard_duration');
const sessionTrend = new Trend('session_duration');
const totalRequests = new Counter('total_requests');

// ============================================
// ENTERPRISE TEST SCENARIOS (Simulation + Real Traffic)
// ============================================
export const options = {
    scenarios: {
        // SCENARIO 1: Baseline/Light Traffic (Daily Health Check)
        baseline: {
            executor: 'constant-vus',
            vus: 5,
            duration: '2m',
            startTime: '0s',
            tags: { scenario: 'baseline' }
        },
        
        // SCENARIO 2: Real Merchant Behavior Simulation
        // Models: Morning peak → Steady → Evening peak
        real_traffic: {
            executor: 'ramping-vus',
            startVUs: 0,
            stages: [
                { duration: '5m', target: 10 },   // Morning ramp (8-9 AM)
                { duration: '10m', target: 20 },  // Early peak (9-10 AM)
                { duration: '20m', target: 15 },  // Mid-day steady (10-12 PM)
                { duration: '10m', target: 5 },   // Lunch dip (12-1 PM)
                { duration: '15m', target: 25 },  // Afternoon peak (1-3 PM)
                { duration: '10m', target: 10 },  // Evening decline (3-4 PM)
                { duration: '5m', target: 0 },    // End of day (4-5 PM)
            ],
            startTime: '2m',
            gracefulRampDown: '1m',
            tags: { scenario: 'real_traffic' }
        },
        
        // SCENARIO 3: Flash Sale / Festival Spike
        spike_test: {
            executor: 'ramping-vus',
            startVUs: 0,
            stages: [
                { duration: '30s', target: 0 },
                { duration: '10s', target: 50 },   // Sudden spike
                { duration: '30s', target: 50 },   // Hold spike
                { duration: '10s', target: 0 },    // Release
            ],
            startTime: '30m',
            gracefulRampDown: '30s',
            tags: { scenario: 'spike_test' }
        },
        
        // SCENARIO 4: Load / Stress Test (Find breaking point)
        stress_test: {
            executor: 'ramping-vus',
            startVUs: 0,
            stages: [
                { duration: '2m', target: 10 },
                { duration: '3m', target: 20 },
                { duration: '3m', target: 30 },
                { duration: '2m', target: 30 },
                { duration: '2m', target: 0 },
            ],
            startTime: '32m',
            tags: { scenario: 'stress_test' }
        },
        
        // SCENARIO 5: Endurance (8-hour simulation)
        endurance: {
            executor: 'ramping-vus',
            startVUs: 0,
            stages: [
                { duration: '5m', target: 15 },
                { duration: '7h', target: 15 },   // 7 hours steady
                { duration: '5m', target: 0 },
            ],
            startTime: '40m',
            tags: { scenario: 'endurance' }
        }
    },
    
    thresholds: {
        // Critical thresholds
        'http_req_duration': ['p(95)<3000', 'p(99)<5000'],
        'http_req_failed': ['rate<0.02'],
        'error_rate': ['rate<0.05'],
        
        // Scenario-specific thresholds
        'dashboard_duration': ['p(95)<2000', 'p(99)<4000'],
        'session_duration': ['p(95)<1000', 'p(99)<2000'],
        
        // Different thresholds for different scenarios
        'http_req_duration{scenario:baseline}': ['p(95)<1000'],
        'http_req_duration{scenario:spike_test}': ['p(95)<5000'],
        'http_req_duration{scenario:endurance}': ['p(95)<3000'],
    },
};

// ============================================
// MERCHANT BEHAVIOR SIMULATION
// ============================================
const MerchantBehaviors = {
    // Small merchants (check dashboard occasionally)
    small: {
        dashboardCheck: 0.7,      // 70% chance to check dashboard
        orderFetch: 0.5,          // 50% chance to fetch orders
        profileCheck: 0.3,        // 30% chance to check profile
        thinkTimeMin: 8,          // Thinks 8-20 seconds
        thinkTimeMax: 20,
    },
    // Medium merchants (more active)
    medium: {
        dashboardCheck: 0.9,
        orderFetch: 0.8,
        profileCheck: 0.6,
        thinkTimeMin: 4,
        thinkTimeMax: 15,
    },
    // Large merchants (very active)
    large: {
        dashboardCheck: 1.0,
        orderFetch: 0.95,
        profileCheck: 0.8,
        thinkTimeMin: 2,
        thinkTimeMax: 8,
    }
};

// ============================================
// DECIDE MERCHANT SIZE BASED ON PARCEL VOLUME
// ============================================
function getMerchantBehavior(avgParcelsPerDay) {
    if (avgParcelsPerDay >= 300) return MerchantBehaviors.large;
    if (avgParcelsPerDay >= 150) return MerchantBehaviors.medium;
    return MerchantBehaviors.small;
}

// ============================================
// SIMULATE REAL USER THINKING TIME
// ============================================
function simulateThinkTime(behavior) {
    // Real merchants don't click instantly
    // They look at screen, read data, think
    const baseTime = Math.random() * (behavior.thinkTimeMax - behavior.thinkTimeMin) + behavior.thinkTimeMin;
    
    // Add occasional longer pauses (bathroom, phone call)
    const longPause = Math.random() < 0.1 ? 30 : 0;
    
    return baseTime + longPause;
}

// ============================================
// REAL MERCHANT WORKFLOW SIMULATION
// ============================================
function simulateMerchantWorkflow(user, headers) {
    const behavior = getMerchantBehavior(user.avgParcelsPerDay);
    let startTime;
    
    // Step 1: Morning login check (always happens first)
    startTime = Date.now();
    let response = http.get(`${BASE_URL}/api/auth/session`, { headers });
    sessionTrend.add(Date.now() - startTime);
    totalRequests.add(1);
    
    let success = response.status === 200;
    check(response, { 'session': (r) => r.status === 200 });
    
    if (!success) {
        errorRate.add(1);
        console.log(`⚠️ ${user.name}: Session failed (${response.status})`);
        return false;
    }
    
    // Real merchant thinks after login
    sleep(simulateThinkTime(behavior));
    
    // Step 2: Check dashboard (based on merchant behavior)
    if (Math.random() < behavior.dashboardCheck) {
        startTime = Date.now();
        response = http.get(`${BASE_URL}/api/merchant/dashboard`, { headers });
        dashboardTrend.add(Date.now() - startTime);
        totalRequests.add(1);
        
        check(response, { 'dashboard': (r) => r.status === 200 });
        if (response.status !== 200) errorRate.add(1);
        
        // Merchant reviews dashboard data
        sleep(simulateThinkTime(behavior) * 0.7);
    }
    
    // Step 3: Fetch orders (core business action)
    if (Math.random() < behavior.orderFetch) {
        startTime = Date.now();
        const orderEndpoint = user.role === 'admin' ? '/api/orders/all' : '/api/orders/my';
        response = http.get(`${BASE_URL}${orderEndpoint}?limit=50`, { headers });
        totalRequests.add(1);
        
        check(response, { 'orders': (r) => r.status === 200 });
        if (response.status !== 200) errorRate.add(1);
        
        // Merchant browses orders
        sleep(simulateThinkTime(behavior));
    }
    
    // Step 4: Check profile/settings (less frequent)
    if (Math.random() < behavior.profileCheck) {
        response = http.get(`${BASE_URL}/api/merchant/profile`, { headers });
        totalRequests.add(1);
        
        check(response, { 'profile': (r) => r.status === 200 });
        if (response.status !== 200) errorRate.add(1);
        
        sleep(simulateThinkTime(behavior) * 0.5);
    }
    
    return true;
}

// ============================================
// ASSIGN VU TO MERCHANT
// ============================================
function assignUserToVU(vuId) {
    const userIndex = (vuId - 1) % USERS.length;
    return USERS[userIndex];
}

// ============================================
// BUILD HEADERS WITH CSRF TOKEN
// ============================================
function buildHeaders(user) {
    return {
        'X-CSRF-Token': user.csrfToken,
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        'X-User-Role': user.role,
        'X-Simulation': 'real-traffic',
        'User-Agent': 'Merchant-Panel/v2',
    };
}

// ============================================
// SETUP - Initialize test environment
// ============================================
export function setup() {
    console.log('\n========================================');
    console.log('🏢 DHL-LEVEL ENTERPRISE LOAD TEST');
    console.log('========================================');
    console.log('📊 Test Design: Simulation + Real Traffic');
    console.log('========================================\n');
    
    // Verify all CSRF tokens
    for (const user of USERS) {
        const testHeaders = buildHeaders(user);
        const response = http.get(`${BASE_URL}/api/auth/session`, { headers: testHeaders });
        
        if (response.status === 200) {
            console.log(`✅ ${user.name}: Validated (${user.avgParcelsPerDay} parcels/day)`);
        } else {
            console.log(`❌ ${user.name}: INVALID TOKEN!`);
        }
        sleep(0.5);
    }
    
    console.log('\n🎯 Scenarios Starting:\n');
    console.log('   🔵 Baseline: 2 minutes (Health check)');
    console.log('   🟢 Real Traffic: 45 minutes (Daily pattern)');
    console.log('   🔴 Spike Test: 1 minute (Flash sale)');
    console.log('   🟠 Stress Test: 12 minutes (Find limits)');
    console.log('   🟣 Endurance: 7+ hours (Memory leak check)\n');
    
    return {
        startTime: new Date().toISOString(),
        users: USERS,
    };
}

// ============================================
// MAIN TEST FUNCTION
// ============================================
export default function (data) {
    const vuId = __VU;
    const iteration = __ITER;
    const scenario = __ENV.SCENARIO || 'real_traffic';
    
    const user = assignUserToVU(vuId);
    const headers = buildHeaders(user);
    
    // Log every 10th iteration per VU (reduced noise)
    if (iteration % 10 === 0) {
        console.log(`👤 VU ${vuId} | ${user.name} | Parcels: ${user.avgParcelsPerDay}/day | Iteration: ${iteration}`);
    }
    
    // Simulate real merchant workflow
    const success = simulateMerchantWorkflow(user, headers);
    
    if (!success) {
        console.log(`❌ VU ${vuId}: Workflow failed at iteration ${iteration}`);
    }
    
    // Final think time before next iteration
    const behavior = getMerchantBehavior(user.avgParcelsPerDay);
    const finalThinkTime = simulateThinkTime(behavior);
    sleep(finalThinkTime);
}

// ============================================
// TEARDOWN - Cleanup
// ============================================
export function teardown(data) {
    console.log('\n========================================');
    console.log('📊 ENTERPRISE LOAD TEST COMPLETED');
    console.log('========================================');
    console.log(`🕐 Started: ${data.startTime}`);
    console.log(`🕐 Ended: ${new Date().toISOString()}`);
    console.log('========================================\n');
}

// ============================================
// ENTERPRISE REPORT
// ============================================
export function handleSummary(data) {
    const totalReqs = data.metrics.total_requests?.values?.count || 0;
    const errorRateValue = data.metrics.error_rate?.values?.rate || 0;
    const sessionAvg = data.metrics.session_duration?.values?.avg || 0;
    const dashboardAvg = data.metrics.dashboard_duration?.values?.avg || 0;
    
    const totalChecks = data.metrics.checks?.values?.total || 0;
    const passes = data.metrics.checks?.values?.passes || 0;
    const successRate = totalChecks > 0 ? (passes / totalChecks * 100) : 0;
    
    console.log('\n========================================');
    console.log('📈 ENTERPRISE TEST RESULTS');
    console.log('========================================');
    console.log(`✅ Total Requests: ${totalReqs}`);
    console.log(`✅ Success Rate: ${successRate.toFixed(2)}%`);
    console.log(`✅ Error Rate: ${(errorRateValue * 100).toFixed(2)}%`);
    console.log(`📊 Session Avg: ${sessionAvg.toFixed(2)}ms`);
    console.log(`📊 Dashboard Avg: ${dashboardAvg.toFixed(2)}ms`);
    console.log(`👥 Peak VUs: ${data.metrics.vus_max?.values?.value || 0}`);
    console.log('========================================\n');
    
    // Detailed report for analysis
    const report = {
        timestamp: new Date().toISOString(),
        summary: {
            totalRequests: totalReqs,
            successRate: `${successRate.toFixed(2)}%`,
            errorRate: `${(errorRateValue * 100).toFixed(2)}%`,
            sessionAvgMs: sessionAvg,
            dashboardAvgMs: dashboardAvg,
            peakVUs: data.metrics.vus_max?.values?.value || 0,
        },
        thresholds: data.metrics.thresholds,
        scenarios: options.scenarios,
        users: USERS.map(u => ({ name: u.name, parcelsPerDay: u.avgParcelsPerDay })),
    };
    
    return {
        'enterprise-report.json': JSON.stringify(report, null, 2),
        'full-metrics.json': JSON.stringify(data, null, 2),
    };
}