import { CLINIC_DATE_PIPE_OPTIONS } from './app/clinic-time';
import { provideZoneChangeDetection } from '@angular/core';
import { bootstrapApplication } from '@angular/platform-browser';
import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { DATE_PIPE_DEFAULT_OPTIONS } from '@angular/common';
import { AppComponent } from './app/app.component';
import { authInterceptor } from './app/api.service';
bootstrapApplication(AppComponent, {
  providers: [
    { provide: DATE_PIPE_DEFAULT_OPTIONS, useValue: CLINIC_DATE_PIPE_OPTIONS },
    provideZoneChangeDetection(),
    provideHttpClient(withInterceptors([authInterceptor])),
  ],
}).catch(console.error);
