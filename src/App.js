// src/App.js
// Full app: Firebase (anonymous auth) + Firestore + Gemini proxy client calls.
// Replace your src/App.js content with this file.

import React, { useState, useEffect, useContext } from "react";
import logo from './logo.svg';
import './App.css';

import {
  signInAnonymously,
  onAuthStateChanged,
  signOut
} from "firebase/auth";

import {
  doc,
  setDoc,
  onSnapshot,
  collection,
  query,
  addDoc,
  updateDoc,
  runTransaction,
  Timestamp
} from "firebase/firestore";

import {
  Loader2,
  Zap,
  Trophy,
  MapPin,
  XCircle,
  CheckCircle,
  Truck,
  User,
  AlertTriangle,
  MessageSquare,
  LogOut
} from "lucide-react";

import { db, auth, APP_ID } from "./firebase";

// ---------------------- CONFIG (from .env.local) ----------------------
const GEMINI_PROXY_PATH = process.env.REACT_APP_GEMINI_PROXY_URL || "/api/gemini"; // serverless proxy you will deploy on Vercel/Netlify

// ---------------------- CONTEXT ----------------------
const AppContext = React.createContext({});

// ---------------------- UTILITIES ----------------------
// Call the Gemini proxy serverless endpoint (server holds the real key)
const callGeminiProxy = async (payload) => {
  try {
    const res = await fetch(GEMINI_PROXY_PATH, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    if (!res.ok) {
      const text = await res.text();
      console.error("Gemini proxy error:", res.status, text);
      return null;
    }
    return await res.json();
  } catch (e) {
    console.error("Gemini proxy fetch failed:", e);
    return null;
  }
};

// Helper wrapper: structured call for small LLM tasks
const callGeminiForText = async (systemInstruction, userQuery) => {
  // Minimal payload that matches the Gemini generateContent API shape
  const payload = {
    contents: [{ parts: [{ text: userQuery }] }],
    systemInstruction: { parts: [{ text: systemInstruction }] },
  };
  const json = await callGeminiProxy(payload);
  const text = json?.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
  return text;
};

// Reward suggestion via Gemini (if proxy exists)
const getRewardSuggestionRemote = async (classification, priority) => {
  const systemPrompt =
    "You are an economic consultant for an environmental rewards program. Given a waste classification and priority, return only a single numeric value (integer) for a 'Base Reporter Reward' in points.";
  const userQuery = `Waste: ${classification}. Priority: ${priority}. Provide a single integer only.`;
  const reply = await callGeminiForText(systemPrompt, userQuery);
  const numeric = reply?.match(/\d+/);
  return numeric ? parseInt(numeric[0], 10) : 10;
};

// Simple fallback classifier (if you want local fallback)
const classifyWasteLocal = () => {
  const classes = ['High-Priority Plastic', 'Hazardous E-Waste', 'Organic Compost', 'Mixed Recyclables'];
  const classification = classes[Math.floor(Math.random() * classes.length)];
  const priority = classification.includes('Hazardous') || classification.includes('Plastic') ? 'High' : 'Medium';
  return { classification, priority };
};

// Resize image and convert to Base64 (keeps Firestore doc small)
const resizeImageAndConvertToBase64 = (file, maxWidth = 800, quality = 0.7) => {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (event) => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        let width = img.width;
        let height = img.height;
        if (width > maxWidth || height > maxWidth) {
          if (width > height) {
            height = height * (maxWidth / width);
            width = maxWidth;
          } else {
            width = width * (maxWidth / height);
            height = maxWidth;
          }
        }
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, width, height);
        const resizedBase64 = canvas.toDataURL('image/jpeg', quality);
        resolve(resizedBase64);
      };
      img.onerror = (error) => reject(error);
      img.src = event.target.result;
    };
    reader.onerror = (error) => reject(error);
    reader.readAsDataURL(file);
  });
};

// ---------------------- GEMINI FEATURE COMPONENTS ----------------------
const WasteInsightGenerator = ({ classification, priority }) => {
  const [insight, setInsight] = useState("Tap '✨ Generate Handling Guide' for expert advice...");
  const [isLoading, setIsLoading] = useState(false);

  const generateGuide = async () => {
    if (isLoading) return;
    setIsLoading(true);
    setInsight("Generating personalized guidance...");
    const system = "You are a professional waste management and safety expert. In two sentences, explain safe handling and disposal for the given classification.";
    const userQuery = `Classification: ${classification}. Priority: ${priority}.`;
    const reply = await callGeminiForText(system, userQuery);
    setInsight(reply || "No response from Gemini proxy.");
    setIsLoading(false);
  };

  return (
    <div className="mt-3 p-3 bg-gray-50 rounded-xl border border-gray-200">
      <p className="text-xs font-semibold text-gray-700 mb-2">✨ Waste Handling Guide (Gemini)</p>
      <p className="text-sm text-gray-600 mb-3 italic">{insight}</p>
      <button
        onClick={generateGuide}
        disabled={isLoading}
        className={`px-3 py-1 text-xs rounded-lg font-medium transition duration-150 flex items-center shadow-md ${isLoading ? 'bg-gray-300 text-gray-600 cursor-not-allowed' : 'bg-pink-600 text-white hover:bg-pink-700'}`}
      >
        {isLoading ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : '✨'}
        {isLoading ? 'Generating...' : 'Generate Handling Guide'}
      </button>
    </div>
  );
};

const MonitorSummaryGenerator = ({ report }) => {
  const { userRole } = useContext(AppContext);
  const [summary, setSummary] = useState("Tap '✨ Generate Monitor Summary' for an overview.");
  const [isLoading, setIsLoading] = useState(false);

  if (userRole !== 'monitor' || report.status !== 'Pending Review') return null;

  const generateSummary = async () => {
    if (isLoading) return;
    setIsLoading(true);
    setSummary("Analyzing report data and drafting recommendation...");
    const systemPrompt = "You are an administrative assistant reviewing a cleanup report. Provide a neutral 1-2 sentence summary and recommend 'Approve' or 'Verify Closer' if status is 'Pending Review'.";
    const userQuery = `Status: ${report.status}. Class: ${report.aiClassification}. Priority: ${report.priority}. BaseReward: ${report.baseReward || 10}.`;
    const reply = await callGeminiForText(systemPrompt, userQuery);
    setSummary(reply || "No response from Gemini proxy.");
    setIsLoading(false);
  };

  return (
    <div className="mt-3 p-3 bg-red-50 rounded-xl border border-red-200">
      <p className="text-xs font-semibold text-red-700 mb-2">✨ Monitor Review Assistant (Gemini)</p>
      <p className="text-sm text-gray-800 mb-3 italic">{summary}</p>
      <button
        onClick={generateSummary}
        disabled={isLoading}
        className={`px-3 py-1 text-xs rounded-lg font-medium transition duration-150 flex items-center shadow-md ${isLoading ? 'bg-gray-300 text-gray-600 cursor-not-allowed' : 'bg-red-600 text-white hover:bg-red-700'}`}
      >
        {isLoading ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : '✨'}
        {isLoading ? 'Analyzing...' : 'Generate Monitor Summary'}
      </button>
    </div>
  );
};

// ---------------------- MAIN APP ----------------------
const App = () => {
  // firebase objects are imported from src/firebase.js
  // user/session
  const [userId, setUserId] = useState(null);
  const [isSystemReady, setIsSystemReady] = useState(false);
  const [userProfile, setUserProfile] = useState(undefined); // undefined = loading, null = setup required, object = ready
  const [userName, setUserName] = useState('');
  const [userRole, setUserRole] = useState('');

  // UI & data
  const [view, setView] = useState('reports');
  const [reports, setReports] = useState([]);
  const [isLoadingReports, setIsLoadingReports] = useState(true);
  const [modal, setModal] = useState({ visible: false, title: '', message: '', type: 'info' });

  const alertUser = ({ title, message, type }) => {
    setModal({ visible: true, title, message, type });
  };

  // --- Firebase Auth init (anonymous by default)
  useEffect(() => {
    try {
      // sign in anonymously (using imported auth)
      signInAnonymously(auth).catch(err => {
        console.warn("Anonymous sign-in failed (check auth settings):", err.message);
      });

      const unsubscribe = onAuthStateChanged(auth, (user) => {
        if (user) {
          setUserId(user.uid);
        } else {
          setUserId(null);
        }
        setIsSystemReady(true);
      });

      return () => unsubscribe();
    } catch (e) {
      console.error("Firebase Initialization Error:", e);
      alertUser({ title: "System Error", message: "Failed to initialize/authenticate Firebase.", type: 'error' });
    }
  }, []);

  // --- Profile listener: checks for user profile doc and sets authorization
  useEffect(() => {
    if (userId) {
      const profileDocRef = doc(db, `artifacts/${APP_ID}/users/${userId}/profiles`, 'public');
      const unsubscribeProfile = onSnapshot(profileDocRef, (docSnap) => {
        if (docSnap.exists && docSnap.exists()) {
          const profileData = docSnap.data();
          setUserProfile(profileData);
          setUserName(profileData.name);
          setUserRole(profileData.role);
          if (view === 'setup') setView('reports');
        } else {
          setUserProfile(null);
          setView('setup');
        }
      }, (error) => {
        if (error.code === 'permission-denied') {
          console.warn("Profile Read Blocked: user likely has no profile yet.");
          setUserProfile(null);
          setView('setup');
        } else {
          console.error("Error fetching profile:", error);
          setUserProfile(null);
          setView('setup');
        }
      });
      return () => unsubscribeProfile();
    }
  }, [userId, view]);

  // --- Reports listener (only when profile loaded)
  useEffect(() => {
    if (userProfile) {
      setIsLoadingReports(true);
      const reportsRef = collection(db, `artifacts/${APP_ID}/public/data/reports`);
      const q = query(reportsRef);
      const unsubscribe = onSnapshot(q, (snapshot) => {
        const docs = snapshot.docs.map(d => ({ id: d.id, ...d.data() }));
        docs.sort((a, b) => {
          const ta = a.reportedAt instanceof Timestamp ? a.reportedAt.toMillis() : (a.reportedAt || 0);
          const tb = b.reportedAt instanceof Timestamp ? b.reportedAt.toMillis() : (b.reportedAt || 0);
          return tb - ta;
        });
        setReports(docs);
        setIsLoadingReports(false);
      }, (error) => {
        console.error("Reports listener error:", error);
        setIsLoadingReports(false);
      });
      return () => unsubscribe();
    } else {
      setIsLoadingReports(false);
      setReports([]);
    }
  }, [userProfile]);

  // --- PROFILE SETUP (writes profile doc)
  const handleProfileSetup = async (name, role) => {
    if (!userId) return;
    try {
      const profileData = {
        name,
        role,
        totalReporterPoints: 0,
        totalPickerPoints: 0,
        dateJoined: new Date(),
        publicUserId: userId,
      };
      const profileDocRef = doc(db, `artifacts/${APP_ID}/users/${userId}/profiles`, 'public');
      await setDoc(profileDocRef, profileData);
      alertUser({ title: "Setup Success!", message: "Profile created.", type: 'success' });
    } catch (e) {
      console.error("Profile Setup Failed:", e);
      alertUser({ title: "Setup Failed", message: e.message, type: 'error' });
    }
  };

  // --- REPORT SUBMIT (image file + simulated classification + optional Gemini reward)
  const handleReportSubmission = async (imageFile, location) => {
    if (!userId || !userProfile) {
      alertUser({ title: "Submission Failed", message: "Please finish setup and wait for profile to load.", type: 'error' });
      return;
    }
    try {
      const base64Image = await resizeImageAndConvertToBase64(imageFile);
      // attempt remote reward suggestion via proxy; fallback to local classifier
      const { classification, priority } = classifyWasteLocal(base64Image);
      let baseReward = 10;
      // try Gemini only if proxy available (non-blocking)
      try {
        baseReward = await getRewardSuggestionRemote(classification, priority) || baseReward;
      } catch (e) {
        console.warn("Gemini reward suggestion failed, using fallback:", e);
      }

      const reportsRef = collection(db, `artifacts/${APP_ID}/public/data/reports`);
      const newReport = {
        reporterId: userId,
        reporterName: userName,
        location,
        originalImageUrl: base64Image,
        aiClassification: classification,
        priority,
        baseReward,
        status: 'Reported',
        pickerId: null,
        pickerName: null,
        reportedAt: new Date(),
        reporterRewardIssued: false,
        pickerRewardIssued: false,
      };
      const docRef = await addDoc(reportsRef, newReport);
      alertUser({ title: "Report Submitted!", message: `Classified: ${classification}. Reward: ${baseReward} pts. ID: ${docRef.id}`, type: 'success' });
    } catch (error) {
      console.error("Error submitting report:", error);
      alertUser({ title: "Submission Failed", message: error.message, type: 'error' });
    }
  };

  // --- CLAIM, PROOF, APPROVAL HANDLERS ---
  const handleClaimReport = async (reportId) => {
    if (!userId || !userProfile) return alertUser({ title: "Claim Failed", message: "Profile not ready.", type: 'error' });
    try {
      const reportDocRef = doc(db, `artifacts/${APP_ID}/public/data/reports`, reportId);
      await updateDoc(reportDocRef, { status: 'Claimed', pickerId: userId, pickerName: userName });
      alertUser({ title: "Report Claimed!", message: "Proceed to cleanup.", type: 'success' });
    } catch (e) {
      console.error("Claim failed:", e);
      alertUser({ title: "Claim Failed", message: e.message, type: 'error' });
    }
  };

  const handleSubmitProof = async (reportId, cleanupFile, location) => {
    if (!userId || !userProfile) return alertUser({ title: "Submission Failed", message: "Profile not ready.", type: 'error' });
    try {
      const base64Image = await resizeImageAndConvertToBase64(cleanupFile);
      const reportDocRef = doc(db, `artifacts/${APP_ID}/public/data/reports`, reportId);
      await updateDoc(reportDocRef, { status: 'Pending Review', cleanupPhotoUrl: base64Image, pickerLocation: location, proofSubmittedAt: new Date() });
      alertUser({ title: "Proof Submitted!", message: "Pending monitor review.", type: 'info' });
    } catch (e) {
      console.error("Proof submit failed:", e);
      alertUser({ title: "Submission Failed", message: e.message, type: 'error' });
    }
  };

  const handleFinalApproval = async (report, approvalType) => {
    if (userRole !== 'monitor' || !userProfile) return;
    const reportRef = doc(db, `artifacts/${APP_ID}/public/data/reports`, report.id);
    const reporterProfileRef = doc(db, `artifacts/${APP_ID}/users/${report.reporterId}/profiles`, 'public');
    const pickerProfileRef = doc(db, `artifacts/${APP_ID}/users/${report.pickerId}/profiles`, 'public');
    const rewardReporter = report.baseReward || 10;
    const rewardPicker = rewardReporter * 3;
    try {
      await runTransaction(db, async (transaction) => {
        if (approvalType === 'approve') {
          transaction.update(reportRef, {
            status: 'Completed',
            monitorId: userId,
            monitorName: userName,
            completedAt: new Date(),
            reporterRewardIssued: true,
            pickerRewardIssued: true,
            monitorMessage: `Thank you for cleaning. Rewards: Reporter +${rewardReporter}, Picker +${rewardPicker}.`
          });
          const rp = await transaction.get(reporterProfileRef);
          const currentReporterPoints = rp.data()?.totalReporterPoints || 0;
          transaction.update(reporterProfileRef, { totalReporterPoints: currentReporterPoints + rewardReporter });

          const pp = await transaction.get(pickerProfileRef);
          const currentPickerPoints = pp.data()?.totalPickerPoints || 0;
          transaction.update(pickerProfileRef, { totalPickerPoints: currentPickerPoints + rewardPicker });

          alertUser({ title: "Report Approved", message: `Rewards issued: Reporter +${rewardReporter}, Picker +${rewardPicker}.`, type: 'success' });
        } else {
          transaction.update(reportRef, {
            status: 'Rejected',
            monitorId: userId,
            monitorName: userName,
            monitorMessage: "Proof rejected. Please resubmit.",
            pickerId: null,
            pickerName: null
          });
          alertUser({ title: "Report Rejected", message: "Proof rejected. Report re-opened.", type: 'error' });
        }
      });
    } catch (e) {
      console.error("Approval transaction failed:", e);
      alertUser({ title: "Approval Failed", message: e.message, type: 'error' });
    }
  };

  // --- Logout (signOut) ---
  const handleLogout = async () => {
    try {
      await signOut(auth);
      alertUser({ title: "Signed Out", message: "You have been signed out.", type: 'info' });
      setUserProfile(null);
      setUserName('');
      setUserRole('');
      setView('setup');
    } catch (e) {
      console.error("Logout failed:", e);
      alertUser({ title: "Logout Failed", message: e.message, type: 'error' });
    }
  };

  // ---------------------- UI COMPONENTS ----------------------
  // (Smaller UI components adapted from original; trimmed to essential for readability)
  const SetupForm = () => {
    const [name, setNameLocal] = useState('');
    const [role, setRoleLocal] = useState('reporter');
    const roles = {
      'reporter': "Citizen Reporter",
      'picker': "Garbage Picker",
      'monitor': "Government Monitor"
    };
    const submit = (e) => {
      e.preventDefault();
      if (!name.trim()) return alertUser({ title: "Missing", message: "Enter name.", type: 'error' });
      handleProfileSetup(name.trim(), role);
    };
    return (
      <div className="p-8 bg-white rounded-xl shadow-md max-w-lg mx-auto mt-12">
        <h2 className="text-2xl font-bold mb-4">System Setup</h2>
        <form onSubmit={submit} className="space-y-4">
          <input value={name} onChange={(e)=>setNameLocal(e.target.value)} className="w-full p-3 border rounded" placeholder="Your full name" />
          <select value={role} onChange={(e)=>setRoleLocal(e.target.value)} className="w-full p-3 border rounded">
            {Object.entries(roles).map(([k,v]) => <option key={k} value={k}>{k.toUpperCase()} - {v}</option>)}
          </select>
          <button type="submit" className="w-full bg-indigo-600 text-white p-3 rounded">Confirm & Enter</button>
        </form>
      </div>
    );
  };

  const ReportNewForm = () => {
    const [file, setFile] = useState(null);
    const [isLoading, setIsLoading] = useState(false);
    const [location] = useState({ lat: (30 + Math.random()*0.1).toFixed(4), lon: (78 + Math.random()*0.1).toFixed(4) });

    const onSubmit = async (e) => {
      e.preventDefault();
      if (!file) return alertUser({ title: "Error", message: "Select an image", type: 'error' });
      setIsLoading(true);
      await handleReportSubmission(file, location);
      setFile(null);
      setIsLoading(false);
      setView('reports');
    };

    return (
      <div className="p-6 bg-white rounded-xl shadow max-w-lg mx-auto">
        <h3 className="text-xl font-semibold mb-3">New Waste Report</h3>
        <p className="mb-3 text-sm text-gray-600">Location: {location.lat}, {location.lon}</p>
        <input type="file" accept="image/*" onChange={(e)=>setFile(e.target.files[0])} className="mb-4" />
        <button onClick={onSubmit} disabled={isLoading} className={`w-full p-3 rounded text-white ${isLoading ? 'bg-gray-400' : 'bg-green-600'}`}>
          {isLoading ? <span className="flex items-center justify-center"><Loader2 className="mr-2 animate-spin" />Submitting...</span> : 'Submit Report & Earn'}
        </button>
        <button onClick={()=>setView('reports')} className="mt-3 w-full text-center text-sm text-indigo-600">Back</button>
      </div>
    );
  };

  const CleanupProofForm = ({ report, onClose }) => {
    const [file, setFile] = useState(null);
    const [isSubmitting, setIsSubmitting] = useState(false);
    const [location] = useState({ lat: (30 + Math.random()*0.1).toFixed(4), lon: (78 + Math.random()*0.1).toFixed(4) });
    const submit = async () => {
      if (!file) return alertUser({ title: "Missing", message: "Please upload proof", type: 'error' });
      setIsSubmitting(true);
      await handleSubmitProof(report.id, file, location);
      setIsSubmitting(false);
      onClose();
    };
    return (
      <div className="p-6 bg-white rounded-xl shadow mt-3">
        <h4 className="font-semibold">Submit Cleanup Proof</h4>
        <p className="text-sm text-gray-600 mb-2">Picker location: {location.lat}, {location.lon}</p>
        <input type="file" accept="image/*" onChange={(e)=>setFile(e.target.files[0])} />
        <div className="mt-3 flex gap-2">
          <button onClick={submit} disabled={isSubmitting} className="bg-yellow-600 text-white px-3 py-1 rounded">{isSubmitting ? 'Submitting...' : 'Submit Proof'}</button>
          <button onClick={onClose} className="px-3 py-1 rounded border">Cancel</button>
        </div>
      </div>
    );
  };

  const ReportItem = ({ report }) => {
    const isPicker = report.pickerId === userId;
    const isReported = report.status === 'Reported';
    const isClaimed = report.status === 'Claimed';
    const isPending = report.status === 'Pending Review';
    const isCompleted = report.status === 'Completed';
    const isRejected = report.status === 'Rejected';
    const [showProof, setShowProof] = useState(false);

    return (
      <div className="p-4 bg-white rounded-xl shadow-md border-l-4 border-indigo-500">
        <div className="flex justify-between">
          <h3 className="font-bold">{report.aiClassification}</h3>
          <span className="text-sm px-2 py-1 rounded bg-gray-100">{report.status}</span>
        </div>
        <p className="text-sm text-gray-600">Loc: {report.location?.lat},{report.location?.lon} | Reporter: {report.reporterName} | Picker: {report.pickerName || 'N/A'}</p>
        <div className="mt-3 flex gap-2">
          {userRole === 'picker' && isReported && <button onClick={()=>handleClaimReport(report.id)} className="bg-indigo-600 text-white px-3 py-1 rounded">Claim Job</button>}
          {userRole === 'picker' && isClaimed && isPicker && !report.cleanupPhotoUrl && <button onClick={()=>setShowProof(s => !s)} className="bg-yellow-600 text-white px-3 py-1 rounded">Submit Proof</button>}
          {showProof && <CleanupProofForm report={report} onClose={()=>setShowProof(false)} />}
          {userRole === 'monitor' && isPending && <div className="flex gap-2">
            <button onClick={()=>handleFinalApproval(report, 'approve')} className="bg-green-600 text-white px-3 py-1 rounded">Approve</button>
            <button onClick={()=>handleFinalApproval(report, 'reject')} className="bg-red-600 text-white px-3 py-1 rounded">Reject</button>
          </div>}
        </div>

        {isCompleted && <p className="text-green-700 mt-3 bg-green-50 p-2 rounded">{report.monitorMessage}</p>}
        {isRejected && <p className="text-red-700 mt-3 bg-red-50 p-2 rounded">Proof rejected. Re-opened for claim.</p>}

        <WasteInsightGenerator classification={report.aiClassification} priority={report.priority} />
        <MonitorSummaryGenerator report={report} />
      </div>
    );
  };

  const ReportsView = () => (
    <div className="space-y-6">
      <div className="flex justify-between items-center">
        <h2 className="text-3xl font-extrabold">Reports Dashboard</h2>
        {userProfile?.role === 'reporter' && <button onClick={()=>setView('reportNew')} className="bg-indigo-600 text-white px-4 py-2 rounded">Report New</button>}
      </div>

      {isLoadingReports ? (
        <div className="p-8 text-center"><Loader2 className="animate-spin mx-auto" /><p>Loading reports...</p></div>
      ) : (
        <div className="grid gap-4">
          {reports.length ? reports.map(r => <ReportItem key={r.id} report={r} />) : <div className="p-8 bg-white rounded text-center">No active reports.</div>}
        </div>
      )}
    </div>
  );

  const ProfileView = () => (
    <div className="max-w-2xl mx-auto">
      <h2 className="text-3xl font-bold mb-4">My Profile</h2>
      <div className="bg-white p-6 rounded shadow">
        <p className="font-semibold">{userProfile?.name}</p>
        <p className="text-sm text-gray-600">Role: {userProfile?.role}</p>
        <p className="mt-3">Reporter Points: {userProfile?.totalReporterPoints ?? 0}</p>
        <p>Picker Points: {userProfile?.totalPickerPoints ?? 0}</p>
        <div className="mt-4">
          <button onClick={()=>setView('reports')} className="px-4 py-2 bg-indigo-600 text-white rounded">Back</button>
        </div>
      </div>
    </div>
  );

  const Navigation = () => (
    <div className="bg-gray-800 text-white p-3 rounded-b">
      <div className="max-w-6xl mx-auto flex justify-between items-center">
        <div className="flex items-center gap-4">
          <Zap className="w-6 h-6 text-indigo-400" /> <span className="font-bold">AI Waste Rewards</span>
          <button onClick={()=>setView('reports')} className={`px-3 py-1 rounded ${view==='reports' ? 'bg-indigo-600' : ''}`}>Reports</button>
          <button onClick={()=>setView('profile')} className={`px-3 py-1 rounded ${view==='profile' ? 'bg-indigo-600' : ''}`}>Profile</button>
        </div>

        <div className="flex items-center gap-3">
          {userProfile && <span className={`px-3 py-1 rounded-full ${userProfile?.role==='monitor' ? 'bg-red-500' : userProfile?.role==='picker' ? 'bg-green-500' : 'bg-indigo-500'}`}>{userProfile?.name} ({userProfile?.role})</span>}
          <button onClick={handleLogout} className="bg-red-600 px-3 py-1 rounded text-white"><LogOut className="w-4 h-4 inline" /> Logout</button>
        </div>
      </div>
    </div>
  );

  const ModalComponent = () => {
    if (!modal.visible) return null;
    const icon = modal.type === 'success' ? <CheckCircle className="w-8 h-8 text-green-600" /> : modal.type === 'error' ? <XCircle className="w-8 h-8 text-red-600" /> : <AlertTriangle className="w-8 h-8 text-yellow-600" />;
    return (
      <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50">
        <div className="bg-white p-6 rounded max-w-sm w-full">
          <div className="flex justify-center mb-3">{icon}</div>
          <h3 className="text-lg font-bold text-center mb-2">{modal.title}</h3>
          <p className="text-sm text-center text-gray-600 mb-4">{modal.message}</p>
          <button onClick={()=>setModal({ visible:false, title:'', message:'', type:'info' })} className="w-full bg-indigo-600 text-white p-2 rounded">Got it</button>
        </div>
      </div>
    );
  };

  if (!isSystemReady) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <Loader2 className="animate-spin w-10 h-10 text-indigo-500" />
        <p className="ml-3">Connecting to Firebase...</p>
      </div>
    );
  }

  if (view === 'setup' || userProfile === null) return <SetupForm />;

  return (
    <AppContext.Provider value={{ userId, userName, userRole, userProfile, handleClaimReport, handleFinalApproval }}>
      <div className="min-h-screen bg-gray-100">
        {userProfile && <Navigation />}
        <main className="max-w-7xl mx-auto p-6">
          <ModalComponent />
          {view === 'reportNew' && <ReportNewForm />}
          {view === 'profile' && <ProfileView />}
          {view === 'reports' && <ReportsView />}
        </main>
      </div>
    </AppContext.Provider>
  );
};

export default App;
